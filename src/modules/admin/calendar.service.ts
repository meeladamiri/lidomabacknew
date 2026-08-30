import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { calculateStayPrice } from "@/modules/reservations/pricing";
import { computeBreakdown } from "@/modules/settings/reservationSettings.service";
import * as activity from "@/modules/activity/activity.service";

/**
 * تقویم و نرخ — the calendar and what each night costs.
 *
 * The host-facing calendar module already writes days; this adds the two
 * things the panel needs that it does not have:
 *
 *   1. **The effective price of each night**, computed the same way a booking
 *      computes it. A grid that shows only the override tells you what was
 *      typed, not what a guest would pay, and those differ on every night
 *      nobody has overridden.
 *   2. **Which booking is holding a blocked day.** "Blocked" with no reason is
 *      the single most common thing support has to go and look up elsewhere.
 *
 * And it adds repricing an existing booking — Odoo's «بروزرسانی قیمت بازه
 * رزرو» — which is the part that touches money and therefore never happens
 * without being previewed and confirmed.
 */

const IRAN_WEEKEND_DAYS = new Set([4, 5]);

const RESIDENCE_PRICING = {
  id: true,
  name: true,
  weekPrice: true,
  weekendPrice: true,
  peakPrice: true,
  extraGuestsPrice: true,
  weeklyDiscount: true,
  monthlyDiscount: true,
  maxCapacity: true,
} as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The month grid: one entry per day, with the price a guest would actually be
 * charged and whatever is holding the date.
 */
export async function getAdminCalendar(residenceId: number, from: string, to: string) {
  const residence = await prisma.residence.findUnique({
    where: { id: residenceId },
    select: RESIDENCE_PRICING,
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const fromDate = new Date(from);
  const toDate = new Date(to);

  const [days, reservations] = await Promise.all([
    prisma.calendarDay.findMany({
      where: { residenceId, roomId: null, date: { gte: fromDate, lte: toDate } },
      orderBy: { date: "asc" },
    }),
    // Only the states that actually hold a date. A cancelled booking's nights
    // are for sale again and must not be drawn as taken.
    prisma.reservation.findMany({
      where: {
        residenceId,
        state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT", "DONE"] },
        startDate: { lte: toDate },
        endDate: { gt: fromDate },
      },
      select: {
        id: true,
        reference: true,
        state: true,
        startDate: true,
        endDate: true,
        guest: { select: { name: true, phone: true } },
      },
    }),
  ]);

  const byDate = new Map(days.map((d) => [iso(d.date), d]));

  const items: {
    date: string;
    is_blocked: boolean;
    is_peak: boolean;
    is_fast: boolean | null;
    special_price: number | null;
    effective_price: number;
    is_weekend: boolean;
    source: "special" | "peak" | "weekend" | "base";
    reservation: { id: number; reference: string; state: string; guest: string | null } | null;
  }[] = [];

  for (let t = new Date(fromDate); t <= toDate; t = new Date(t.getTime() + 86_400_000)) {
    const key = iso(t);
    const day = byDate.get(key);
    const isWeekend = IRAN_WEEKEND_DAYS.has(t.getUTCDay());
    const isPeak = day?.isPeak ?? false;

    // The same ladder `calculateStayPrice` walks, so the grid and the booking
    // can never disagree about a night.
    let effective = residence.weekPrice ?? 0;
    let source: "special" | "peak" | "weekend" | "base" = "base";
    if (isPeak && residence.peakPrice) {
      effective = residence.peakPrice;
      source = "peak";
    } else if (isWeekend && residence.weekendPrice) {
      effective = residence.weekendPrice;
      source = "weekend";
    }
    if (day?.specialPrice) {
      effective = day.specialPrice;
      source = "special";
    }

    const holding = reservations.find((r) => t >= r.startDate && t < r.endDate);

    items.push({
      date: key,
      is_blocked: day?.isBlocked ?? false,
      is_peak: isPeak,
      is_fast: day?.isFast ?? null,
      special_price: day?.specialPrice ?? null,
      effective_price: effective,
      is_weekend: isWeekend,
      source,
      reservation: holding
        ? {
            id: holding.id,
            reference: holding.reference,
            state: holding.state,
            guest: holding.guest?.name ?? holding.guest?.phone ?? null,
          }
        : null,
    });
  }

  return { residence, days: items };
}

export interface AdminCalendarUpdate {
  residenceId: number;
  dates: string[];
  isBlocked?: boolean;
  isPeak?: boolean;
  isFast?: boolean;
  specialPrice?: number | null;
  reset?: boolean;
  actorId: number;
}

/**
 * Writes calendar days from the panel.
 *
 * Separate from the host's version because an admin has no ownership to check
 * and because this one records what it did — a night whose price changed
 * without anything saying who changed it is the reason this feature keeps
 * being asked about.
 */
export async function updateAdminCalendar(input: AdminCalendarUpdate) {
  const residence = await prisma.residence.findUnique({
    where: { id: input.residenceId },
    select: { id: true, name: true },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const dates = input.dates.map((d) => new Date(d));

  if (input.reset) {
    await prisma.calendarDay.deleteMany({
      where: { residenceId: input.residenceId, roomId: null, date: { in: dates } },
    });
  } else {
    const data = {
      ...(input.isBlocked !== undefined ? { isBlocked: input.isBlocked } : {}),
      ...(input.isPeak !== undefined ? { isPeak: input.isPeak } : {}),
      ...(input.isFast !== undefined ? { isFast: input.isFast } : {}),
      ...(input.specialPrice !== undefined ? { specialPrice: input.specialPrice } : {}),
    };

    await prisma.$transaction(
      async (tx) => {
        const existing = await tx.calendarDay.findMany({
          where: { residenceId: input.residenceId, roomId: null, date: { in: dates } },
          select: { id: true, date: true },
        });
        const known = new Set(existing.map((d) => d.date.getTime()));

        if (existing.length > 0) {
          await tx.calendarDay.updateMany({
            where: { id: { in: existing.map((d) => d.id) } },
            data,
          });
        }

        const fresh = dates.filter((d) => !known.has(d.getTime()));
        if (fresh.length > 0) {
          await tx.calendarDay.createMany({
            data: fresh.map((date) => ({
              residenceId: input.residenceId,
              roomId: null,
              date,
              isBlocked: input.isBlocked ?? false,
              isPeak: input.isPeak ?? false,
              isFast: input.isFast,
              specialPrice: input.specialPrice ?? null,
            })),
          });
        }
      },
      { timeout: 15_000 }
    );
  }

  const what = input.reset
    ? "بازگردانی به نرخ پایه"
    : [
        input.specialPrice != null ? `نرخ ${input.specialPrice.toLocaleString("fa-IR")} تومان` : null,
        input.isBlocked === true ? "بستن" : input.isBlocked === false ? "باز کردن" : null,
        input.isPeak === true ? "پیک" : input.isPeak === false ? "حذف پیک" : null,
      ]
        .filter(Boolean)
        .join(" · ");

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: input.residenceId,
    summary: `تقویم و نرخ ${residence.name}: ${what} برای ${input.dates.length.toLocaleString("fa-IR")} روز`,
    details: { dates: input.dates, change: input } as never,
    actorId: input.actorId,
    source: "CALENDAR",
  });

  // Bookings that overlap the days just changed. The panel asks about these
  // rather than repricing them: a booking's price was agreed when it was made,
  // and moving it is a decision, not a consequence.
  const affected = await prisma.reservation.findMany({
    where: {
      residenceId: input.residenceId,
      state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT", "DONE"] },
      startDate: { lt: new Date(Math.max(...dates.map((d) => d.getTime())) + 86_400_000) },
      endDate: { gt: new Date(Math.min(...dates.map((d) => d.getTime()))) },
    },
    select: {
      id: true,
      reference: true,
      state: true,
      startDate: true,
      endDate: true,
      totalAmount: true,
      guest: { select: { name: true, phone: true } },
    },
  });

  return {
    success: true,
    affected: affected.map((r) => ({
      id: r.id,
      reference: r.reference,
      state: r.state,
      start_date: r.startDate,
      end_date: r.endDate,
      total_amount: r.totalAmount,
      guest: r.guest?.name ?? r.guest?.phone ?? null,
    })),
  };
}

/**
 * What a booking would cost if it were priced against today's calendar.
 *
 * Returns both sides — the nights as they were charged and as they would be —
 * because "the total changed by 200,000" is not something anyone can approve.
 * The night that moved is the thing worth seeing.
 */
export async function repriceQuote(reservationId: number) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      reference: true,
      state: true,
      residenceId: true,
      startDate: true,
      endDate: true,
      daysCount: true,
      extraGuestsCount: true,
      totalAmount: true,
      paidAmount: true,
      websiteShare: true,
      vatAmount: true,
      guestCommission: true,
      hostShare: true,
      settledAmount: true,
      clearRemainder: true,
      commissionPercent: true,
      vatPercent: true,
      guestCommissionPercent: true,
    },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const residence = await prisma.residence.findUnique({
    where: { id: reservation.residenceId },
    select: RESIDENCE_PRICING,
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const overrides = await prisma.calendarDay.findMany({
    where: {
      residenceId: reservation.residenceId,
      roomId: null,
      date: { gte: reservation.startDate, lt: reservation.endDate },
    },
    select: { date: true, specialPrice: true, isPeak: true },
  });

  const pricing = calculateStayPrice({
    residence,
    calendarOverrides: overrides,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    extraGuestsCount: reservation.extraGuestsCount,
  });

  // Re-split with the booking's own stored rates, not today's settings. The
  // commission a host agreed to is part of the booking; repricing the nights
  // must not quietly renegotiate it.
  const shares = computeBreakdown(pricing.totalAmount, {
    commissionPercent: reservation.commissionPercent ?? 15,
    vatPercent: reservation.vatPercent ?? 10,
    guestCommissionPercent: reservation.guestCommissionPercent ?? 0,
  });

  const nextRemainder = Math.max(shares.hostShare - reservation.settledAmount, 0);

  // Same fallback the deposit panel uses: a null column means "never set", and
  // the honest answer is the subtraction, not zero. Reading it as zero made a
  // booking that owes the host look settled.
  const currentRemainder =
    reservation.clearRemainder ??
    Math.max((reservation.hostShare ?? 0) - reservation.settledAmount, 0);

  return {
    reservation: {
      id: reservation.id,
      reference: reservation.reference,
      state: reservation.state,
      start_date: reservation.startDate,
      end_date: reservation.endDate,
      nights: reservation.daysCount,
    },
    before: {
      total_amount: reservation.totalAmount,
      website_share: reservation.websiteShare ?? 0,
      vat_amount: reservation.vatAmount ?? 0,
      guest_commission: reservation.guestCommission ?? 0,
      host_share: reservation.hostShare ?? 0,
      clear_remainder: currentRemainder,
      paid_amount: reservation.paidAmount,
    },
    after: {
      total_amount: pricing.totalAmount,
      website_share: shares.websiteShare,
      vat_amount: shares.vatAmount,
      guest_commission: shares.guestCommission,
      host_share: shares.hostShare,
      clear_remainder: nextRemainder,
      paid_amount: reservation.paidAmount,
    },
    difference: {
      total_amount: pricing.totalAmount - reservation.totalAmount,
      host_share: shares.hostShare - (reservation.hostShare ?? 0),
      clear_remainder: nextRemainder - currentRemainder,
    },
    nights: pricing.nightlyBreakdown,
    settled_amount: reservation.settledAmount,
    // Stated rather than left to be inferred: these are the two cases where
    // applying has a consequence beyond the numbers on this booking.
    warnings: [
      ...(reservation.settledAmount > 0
        ? [`${reservation.settledAmount.toLocaleString("fa-IR")} تومان از سهم میزبان قبلاً واریز شده است.`]
        : []),
      ...(reservation.state === "DONE"
        ? ["این رزرو قطعی شده و درآمد میزبان از قبل در کیف پولش ثبت شده است."]
        : []),
    ],
  };
}

/**
 * Applies the reprice.
 *
 * Only reachable after the preview, and it recomputes rather than trusting
 * numbers sent by the client — a total that arrived in a request body is a
 * total somebody could have edited.
 */
export async function applyReprice(input: { reservationId: number; note: string; actorId: number }) {
  const note = input.note?.trim();
  if (!note) throw AppError.badRequest("توضیح تغییر نرخ الزامی است");

  const quote = await repriceQuote(input.reservationId);

  if (Math.abs(quote.difference.total_amount) < 1) {
    throw AppError.badRequest("نرخ این رزرو با تقویم فعلی تفاوتی ندارد");
  }

  const before = quote.before;
  const after = quote.after;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.reservation.update({
      where: { id: input.reservationId },
      data: {
        totalAmount: after.total_amount,
        websiteShare: after.website_share,
        vatAmount: after.vat_amount,
        guestCommission: after.guest_commission,
        hostShare: after.host_share,
        clearRemainder: after.clear_remainder,
        // What the guest still owes moves with the price. Their payments do
        // not — those already happened.
        remainingAmount: Math.max(
          after.total_amount + after.guest_commission - before.paid_amount,
          0
        ),
      },
      select: { id: true, reference: true, hostId: true, state: true },
    });

    // Held income was credited for the old figure. Correcting it here is the
    // difference between a host being paid what the booking now says and being
    // paid what it used to say.
    const credited = await tx.walletTransaction.findFirst({
      where: { reservationId: row.id, kind: "BOOKING_INCOME" },
      select: { id: true },
    });

    const delta = after.host_share - before.host_share;

    if (credited && Math.abs(delta) >= 1) {
      const wallet = await tx.wallet.findUnique({ where: { userId: row.hostId } });
      if (wallet) {
        const blocked = Math.max(wallet.blockedBalance + delta, 0);
        await tx.wallet.update({ where: { id: wallet.id }, data: { blockedBalance: blocked } });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            kind: "ADJUSTMENT",
            amount: delta,
            balanceAfter: wallet.balance,
            description: `اصلاح درآمد بابت تغییر نرخ رزرو ${row.reference}`,
            reservationId: row.id,
          },
        });
      }
    }

    return row;
  });

  activity.diffAndLog(
    {
      totalAmount: before.total_amount,
      hostShare: before.host_share,
      websiteShare: before.website_share,
      clearRemainder: before.clear_remainder,
    },
    {
      totalAmount: after.total_amount,
      hostShare: after.host_share,
      websiteShare: after.website_share,
      clearRemainder: after.clear_remainder,
    },
    {
      reservationId: input.reservationId,
      actorId: input.actorId,
      source: "REPRICE",
      reason: `بروزرسانی نرخ رزرو — ${note}`,
    }
  );

  return { reservation: updated, before, after, difference: quote.difference };
}
