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
export interface PriceBucket {
  key: string;
  label: string;
  nights: number;
  unit_price: number;
  total: number;
}

/**
 * The nights, grouped into the rows the pricing screen shows.
 *
 * Each night falls in exactly one bucket, in the same order of precedence the
 * pricing itself uses: a special price on the day wins, then peak, then
 * weekend, then the base rate. Special prices are grouped by their amount and
 * numbered, because a stay can carry two different ones and a single «قیمت
 * خاص» row would hide that.
 *
 * The base rows are emitted even when empty — a nightly rate table with the
 * weekend row missing reads as "no weekend rate exists" rather than "no
 * weekend nights in this stay".
 */
function priceBuckets(
  pricing: ReturnType<typeof calculateStayPrice>,
  extra: { extraGuestsPrice: number | null; extraGuestsCount: number }
): PriceBucket[] {
  const base = { week: 0, weekend: 0, peak: 0 };
  const baseUnit = { week: 0, weekend: 0, peak: 0 };
  const specials = new Map<number, number>();

  for (const night of pricing.nightlyBreakdown) {
    if (night.isSpecial) {
      specials.set(night.unitPrice, (specials.get(night.unitPrice) ?? 0) + 1);
    } else if (night.isPeak) {
      base.peak++;
      baseUnit.peak = night.unitPrice;
    } else if (night.isWeekend) {
      base.weekend++;
      baseUnit.weekend = night.unitPrice;
    } else {
      base.week++;
      baseUnit.week = night.unitPrice;
    }
  }

  const rows: PriceBucket[] = [
    { key: "week", label: "وسط هفته", nights: base.week, unit_price: baseUnit.week, total: base.week * baseUnit.week },
    { key: "weekend", label: "آخر هفته", nights: base.weekend, unit_price: baseUnit.weekend, total: base.weekend * baseUnit.weekend },
    { key: "peak", label: "ایام پیک", nights: base.peak, unit_price: baseUnit.peak, total: base.peak * baseUnit.peak },
  ];

  [...specials.entries()]
    .sort((a, b) => b[0] - a[0])
    .forEach(([unitPrice, nights], i) => {
      rows.push({
        key: `special-${i + 1}`,
        label: `قیمت خاص میزبان ${i + 1}`,
        nights,
        unit_price: unitPrice,
        total: nights * unitPrice,
      });
    });

  // Extra guests are charged per person per night, so the "nights" column is
  // the stay length and the unit is the per-person rate times the headcount.
  const extraUnit = (extra.extraGuestsPrice ?? 0) * extra.extraGuestsCount;
  rows.push({
    key: "extra-guests",
    label: "نرخ هر نفر اضافه",
    nights: extra.extraGuestsCount > 0 ? pricing.nights : 0,
    unit_price: extraUnit,
    total: pricing.extraGuestsTotal,
  });

  return rows;
}

/**
 * A night the panel has typed a new rate into but not saved yet.
 *
 * Draft rates are priced here rather than in the browser so that the preview
 * an agent approves comes out of the same code that will write the invoice.
 * The alternative — the frontend adding up its own numbers — is two pricing
 * implementations that agree right up until a discount tier applies.
 */
export type DraftRates = Record<string, number>;

/** The stored calendar with the draft rates laid over it, for one date range. */
function mergeDraft(
  stored: { date: Date; specialPrice: number | null; isPeak: boolean }[],
  draft: DraftRates,
  from: Date,
  to: Date
) {
  const byDate = new Map(stored.map((d) => [iso(d.date), d]));

  for (const [key, price] of Object.entries(draft)) {
    const date = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date < from || date >= to) continue;

    const existing = byDate.get(key);
    byDate.set(key, {
      date,
      specialPrice: price,
      isPeak: existing?.isPeak ?? false,
    });
  }

  return [...byDate.values()];
}

export async function repriceQuote(reservationId: number, draft?: DraftRates) {
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

  const stored = await prisma.calendarDay.findMany({
    where: {
      residenceId: reservation.residenceId,
      roomId: null,
      date: { gte: reservation.startDate, lt: reservation.endDate },
    },
    select: { date: true, specialPrice: true, isPeak: true },
  });

  // A draft rate behaves exactly like a special price on that night, which is
  // what saving it would eventually make it.
  const overrides = draft
    ? mergeDraft(stored, draft, reservation.startDate, reservation.endDate)
    : stored;

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
    // The same nights grouped the way the pricing screen asks about them —
    // «۳ شب وسط هفته × ۵٬۰۰۰٬۰۰۰». Grouped here rather than in the browser
    // because which night counts as a weekend, and whether a special price
    // beats a peak one, are pricing rules; a second copy of them in the
    // frontend is a second copy that can disagree with the invoice.
    buckets: priceBuckets(pricing, {
      extraGuestsPrice: residence.extraGuestsPrice,
      extraGuestsCount: reservation.extraGuestsCount,
    }),
    totals: {
      subtotal: pricing.subtotal,
      extra_guests_total: pricing.extraGuestsTotal,
      discount_percent: pricing.discountPercent,
      discount_amount: pricing.discountAmount,
      reservation_amount: pricing.totalAmount,
    },
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
export async function applyReprice(input: {
  reservationId: number;
  note: string;
  actorId: number;
  /**
   * Rates typed in the panel but not written to the calendar.
   *
   * This is how «فقط برای این رزرو» works: the booking is priced with these
   * nights, the listing's calendar keeps the rates every other booking and
   * every future guest sees. Without it the only way to change one booking
   * would be to change the listing, which is a different decision.
   */
  draft?: DraftRates;
}) {
  const note = input.note?.trim();
  if (!note) throw AppError.badRequest("توضیح تغییر نرخ الزامی است");

  const quote = await repriceQuote(input.reservationId, input.draft);

  if (Math.abs(quote.difference.total_amount) < 1) {
    throw AppError.badRequest("نرخ این رزرو تفاوتی با مقدار فعلی ندارد");
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
