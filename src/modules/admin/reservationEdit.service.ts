import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { calculateStayPrice, summarizeBreakdown } from "@/modules/reservations/pricing";
import { Prisma } from "@prisma/client";
import { releaseCalendarDays } from "@/modules/reservations/reservations.service";
import * as activity from "@/modules/activity/activity.service";

/**
 * Editing a booking's commercial terms and its stay, by hand.
 *
 * Both are corrections rather than routine work, and both move money, so they
 * share three rules:
 *
 *   1. A note is required. The audit line is the reason these exist.
 *   2. Every figure is recomputed from the pieces rather than trusted from the
 *      request. A total that arrived in a request body is a total somebody
 *      could have edited.
 *   3. A host whose income was already credited has it corrected by the same
 *      delta, in the same transaction. Otherwise the panel becomes a way to
 *      change what a booking says without changing what anyone is paid.
 */

const fa = (n: number) => Math.round(n).toLocaleString("fa-IR");

/** `hostShare` is what is left of the rent after the site takes its cut. */
function hostShareOf(totalAmount: number, websiteShare: number, vatAmount: number) {
  return Math.max(totalAmount - websiteShare - vatAmount, 0);
}

/** A percentage is stored beside every amount so a later reprice keeps the deal. */
const percentOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * ویرایش مبالغ مؤثر بر صورتحساب.
 *
 * The commission, the VAT and the guest fee are ordinarily derived from
 * settings, but a booking is sometimes agreed on different terms — a waived
 * fee, a negotiated commission — and until now the only way to record that was
 * to edit the rent, which made the invoice say something untrue about the
 * nightly rate.
 *
 * Amounts are what is typed, and the percentages follow from them, so a later
 * reprice reproduces the same deal instead of quietly restoring the default.
 */
export async function updateTerms(input: {
  reservationId: number;
  websiteShare?: number;
  vatAmount?: number;
  guestCommission?: number;
  note: string;
  actorId: number;
  dryRun?: boolean;
}) {
  const note = input.note?.trim();
  if (!note && !input.dryRun) throw AppError.badRequest("توضیح تغییر مبالغ الزامی است");

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: {
      id: true,
      reference: true,
      state: true,
      hostId: true,
      totalAmount: true,
      paidAmount: true,
      websiteShare: true,
      vatAmount: true,
      guestCommission: true,
      hostShare: true,
      settledAmount: true,
      clearRemainder: true,
    },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const before = {
    website_share: reservation.websiteShare ?? 0,
    vat_amount: reservation.vatAmount ?? 0,
    guest_commission: reservation.guestCommission ?? 0,
    host_share: reservation.hostShare ?? 0,
    total_amount: reservation.totalAmount,
    clear_remainder:
      reservation.clearRemainder ??
      Math.max((reservation.hostShare ?? 0) - reservation.settledAmount, 0),
  };

  const websiteShare = input.websiteShare ?? before.website_share;
  const vatAmount = input.vatAmount ?? before.vat_amount;
  const guestCommission = input.guestCommission ?? before.guest_commission;

  if (websiteShare + vatAmount > reservation.totalAmount) {
    throw AppError.badRequest("کارمزد و مالیات نمی‌تواند از مبلغ کل اجاره بیشتر باشد");
  }

  const hostShare = hostShareOf(reservation.totalAmount, websiteShare, vatAmount);
  const nextRemainder = Math.max(hostShare - reservation.settledAmount, 0);

  const after = {
    website_share: websiteShare,
    vat_amount: vatAmount,
    guest_commission: guestCommission,
    host_share: hostShare,
    total_amount: reservation.totalAmount,
    clear_remainder: nextRemainder,
  };

  const preview = {
    reservation: { id: reservation.id, reference: reservation.reference },
    before,
    after,
    difference: {
      host_share: after.host_share - before.host_share,
      guest_due:
        after.total_amount + after.guest_commission - (before.total_amount + before.guest_commission),
    },
    warnings: [
      ...(reservation.settledAmount > 0
        ? [`${fa(reservation.settledAmount)} تومان از سهم میزبان قبلاً واریز شده است.`]
        : []),
      ...(reservation.state === "DONE"
        ? ["این رزرو قطعی شده و درآمد میزبان از قبل در کیف پولش ثبت شده است."]
        : []),
    ],
  };

  if (input.dryRun) return preview;

  await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        websiteShare,
        vatAmount,
        guestCommission,
        hostShare,
        clearRemainder: nextRemainder,
        commissionPercent: percentOf(websiteShare, reservation.totalAmount),
        // VAT is charged on the commission, not the rent — 10% of the cut,
        // which is the rule the whole migration was verified against.
        vatPercent: percentOf(vatAmount, websiteShare),
        guestCommissionPercent: percentOf(guestCommission, reservation.totalAmount),
        remainingAmount: Math.max(
          reservation.totalAmount + guestCommission - reservation.paidAmount,
          0
        ),
      },
    });

    await correctHostIncome(tx, {
      reservationId: reservation.id,
      hostId: reservation.hostId,
      reference: reservation.reference,
      delta: after.host_share - before.host_share,
      why: "تغییر مبالغ",
    });
  });

  activity.diffAndLog(
    { websiteShare: before.website_share, vatAmount: before.vat_amount, guestCommission: before.guest_commission, hostShare: before.host_share },
    { websiteShare: after.website_share, vatAmount: after.vat_amount, guestCommission: after.guest_commission, hostShare: after.host_share },
    { reservationId: reservation.id, actorId: input.actorId, source: "TERMS", reason: note }
  );

  return preview;
}

/**
 * ویرایش تاریخ، شب و نفرات.
 *
 * Changing the dates changes what the stay costs, so the rent is recomputed
 * from the calendar rather than carried over — a five-night price left on a
 * three-night booking is an invoice that disagrees with itself.
 *
 * The calendar is moved with it: the old nights go back on sale and the new
 * ones are taken. Skipping that is how a listing ends up double-booked by its
 * own support team.
 */
export async function updateStay(input: {
  reservationId: number;
  startDate?: string;
  endDate?: string;
  guestsCount?: number;
  extraGuestsCount?: number;
  note: string;
  actorId: number;
  dryRun?: boolean;
}) {
  const note = input.note?.trim();
  if (!note && !input.dryRun) throw AppError.badRequest("توضیح تغییر اقامت الزامی است");

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: {
      id: true,
      reference: true,
      state: true,
      hostId: true,
      residenceId: true,
      startDate: true,
      endDate: true,
      daysCount: true,
      guestsCount: true,
      extraGuestsCount: true,
      totalAmount: true,
      paidAmount: true,
      guestCommission: true,
      hostShare: true,
      websiteShare: true,
      vatAmount: true,
      settledAmount: true,
      commissionPercent: true,
      vatPercent: true,
      guestCommissionPercent: true,
    },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  if (reservation.state === "CANCEL") {
    throw AppError.badRequest("رزرو لغوشده ویرایش نمی‌شود");
  }

  const startDate = input.startDate ? new Date(input.startDate) : reservation.startDate;
  const endDate = input.endDate ? new Date(input.endDate) : reservation.endDate;
  const guestsCount = input.guestsCount ?? reservation.guestsCount;
  const extraGuestsCount = input.extraGuestsCount ?? reservation.extraGuestsCount;

  if (!(endDate > startDate)) {
    throw AppError.badRequest("تاریخ خروج باید بعد از تاریخ ورود باشد");
  }

  const nights = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  if (nights < 1) throw AppError.badRequest("مدت اقامت حداقل یک شب است");
  if (nights > 365) throw AppError.badRequest("مدت اقامت بیش از حد بلند است");

  const residence = await prisma.residence.findUnique({
    where: { id: reservation.residenceId },
    select: {
      weekPrice: true,
      weekendPrice: true,
      peakPrice: true,
      extraGuestsPrice: true,
      weeklyDiscount: true,
      monthlyDiscount: true,
      maxCapacity: true,
      capacity: true,
    },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  if (residence.maxCapacity && guestsCount + extraGuestsCount > residence.maxCapacity) {
    throw AppError.badRequest(
      `ظرفیت این اقامتگاه حداکثر ${fa(residence.maxCapacity)} نفر است`
    );
  }

  // Nights the new range needs that another live booking already holds. The
  // booking's own nights are excluded — moving from 12–15 to 12–16 must not
  // collide with itself.
  const clashes = await prisma.reservation.findMany({
    where: {
      residenceId: reservation.residenceId,
      id: { not: reservation.id },
      state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT", "DONE"] },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    },
    select: { id: true, reference: true, startDate: true, endDate: true },
  });

  const overrides = await prisma.calendarDay.findMany({
    where: {
      residenceId: reservation.residenceId,
      roomId: null,
      date: { gte: startDate, lt: endDate },
    },
    select: { date: true, specialPrice: true, isPeak: true },
  });

  const pricing = calculateStayPrice({
    residence,
    calendarOverrides: overrides,
    startDate,
    endDate,
    extraGuestsCount,
  });

  const commissionPercent = reservation.commissionPercent ?? 15;
  const vatPercent = reservation.vatPercent ?? 10;
  const guestCommissionPercent = reservation.guestCommissionPercent ?? 0;

  const websiteShare = (pricing.totalAmount * commissionPercent) / 100;
  const vatAmount = (websiteShare * vatPercent) / 100;
  const guestCommission = (pricing.totalAmount * guestCommissionPercent) / 100;
  const hostShare = hostShareOf(pricing.totalAmount, websiteShare, vatAmount);
  const nextRemainder = Math.max(hostShare - reservation.settledAmount, 0);

  const preview = {
    reservation: { id: reservation.id, reference: reservation.reference },
    before: {
      start_date: reservation.startDate,
      end_date: reservation.endDate,
      nights: reservation.daysCount,
      guests_count: reservation.guestsCount,
      extra_guests_count: reservation.extraGuestsCount,
      total_amount: reservation.totalAmount,
      host_share: reservation.hostShare ?? 0,
      guest_commission: reservation.guestCommission ?? 0,
    },
    after: {
      start_date: startDate,
      end_date: endDate,
      nights,
      guests_count: guestsCount,
      extra_guests_count: extraGuestsCount,
      total_amount: pricing.totalAmount,
      host_share: hostShare,
      guest_commission: guestCommission,
    },
    nights_breakdown: pricing.nightlyBreakdown,
    clashes: clashes.map((c) => ({
      id: c.id,
      reference: c.reference,
      start_date: c.startDate,
      end_date: c.endDate,
    })),
    warnings: [
      ...(reservation.settledAmount > 0
        ? [`${fa(reservation.settledAmount)} تومان از سهم میزبان قبلاً واریز شده است.`]
        : []),
      ...(reservation.paidAmount > pricing.totalAmount + guestCommission
        ? ["مبلغ پرداختی مهمان از مبلغ جدید بیشتر می‌شود؛ مابه‌التفاوت باید برگردد."]
        : []),
      ...(residence.capacity && guestsCount > residence.capacity
        ? [`ظرفیت پایه ${fa(residence.capacity)} نفر است و این رزرو از آن بیشتر می‌شود.`]
        : []),
    ],
  };

  if (input.dryRun) return preview;

  if (clashes.length > 0) {
    throw AppError.badRequest(
      `این بازه با رزرو ${clashes.map((c) => c.reference).join("، ")} تداخل دارد`
    );
  }

  const movedDates =
    startDate.getTime() !== reservation.startDate.getTime() ||
    endDate.getTime() !== reservation.endDate.getTime();

  await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        startDate,
        endDate,
        daysCount: nights,
        guestsCount,
        extraGuestsCount,
        totalAmount: pricing.totalAmount,
        priceBreakdown: summarizeBreakdown(pricing, extraGuestsCount) as unknown as Prisma.InputJsonValue,
        websiteShare,
        vatAmount,
        guestCommission,
        hostShare,
        clearRemainder: nextRemainder,
        remainingAmount: Math.max(
          pricing.totalAmount + guestCommission - reservation.paidAmount,
          0
        ),
      },
    });

    await correctHostIncome(tx, {
      reservationId: reservation.id,
      hostId: reservation.hostId,
      reference: reservation.reference,
      delta: hostShare - (reservation.hostShare ?? 0),
      why: "تغییر تاریخ یا نفرات",
    });
  });

  if (movedDates) {
    // Old nights back on sale first, then the new ones taken. Doing it the
    // other way round leaves a window where a range that overlaps both looks
    // free to a guest checking out at that moment.
    await releaseCalendarDays(reservation.residenceId, reservation.startDate, reservation.endDate);
    await blockCalendarDays(reservation.residenceId, startDate, endDate);
  }

  activity.diffAndLog(
    {
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      daysCount: reservation.daysCount,
      guestsCount: reservation.guestsCount,
      extraGuestsCount: reservation.extraGuestsCount,
      totalAmount: reservation.totalAmount,
    },
    {
      startDate,
      endDate,
      daysCount: nights,
      guestsCount,
      extraGuestsCount,
      totalAmount: pricing.totalAmount,
    },
    { reservationId: reservation.id, actorId: input.actorId, source: "STAY", reason: note }
  );

  return preview;
}

/** Takes the nights off sale for a booking that has just moved onto them. */
async function blockCalendarDays(residenceId: number, startDate: Date, endDate: Date) {
  const dates: Date[] = [];
  for (const d = new Date(startDate); d < endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(new Date(d));
  }
  if (dates.length === 0) return;

  const existing = await prisma.calendarDay.findMany({
    where: { residenceId, roomId: null, date: { in: dates } },
    select: { id: true, date: true },
  });
  const known = new Set(existing.map((d) => d.date.getTime()));

  if (existing.length > 0) {
    await prisma.calendarDay.updateMany({
      where: { id: { in: existing.map((d) => d.id) } },
      data: { isBlocked: true },
    });
  }

  const fresh = dates.filter((d) => !known.has(d.getTime()));
  if (fresh.length > 0) {
    await prisma.calendarDay.createMany({
      data: fresh.map((date) => ({ residenceId, roomId: null, date, isBlocked: true })),
    });
  }
}

/**
 * Held income was credited for the old figure. Correcting it here is the
 * difference between a host being paid what the booking now says and being
 * paid what it used to say.
 */
async function correctHostIncome(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: { reservationId: number; hostId: number; reference: string; delta: number; why: string }
) {
  if (Math.abs(input.delta) < 1) return;

  const credited = await tx.walletTransaction.findFirst({
    where: { reservationId: input.reservationId, kind: "BOOKING_INCOME" },
    select: { id: true },
  });
  if (!credited) return;

  const wallet = await tx.wallet.findUnique({ where: { userId: input.hostId } });
  if (!wallet) return;

  await tx.wallet.update({
    where: { id: wallet.id },
    data: { blockedBalance: Math.max(wallet.blockedBalance + input.delta, 0) },
  });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      kind: "ADJUSTMENT",
      amount: input.delta,
      balanceAfter: wallet.balance,
      description: `اصلاح درآمد بابت ${input.why} رزرو ${input.reference}`,
      reservationId: input.reservationId,
    },
  });
}
