import { Prisma, type CancelNotifyMode, type ReservationCancelledBy } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { onReservationStateChanged } from "@/modules/conversations/bookingHooks";
import * as notify from "@/modules/notifications/events";
import * as walletService from "@/modules/wallet/wallet.service";
import { getSettings } from "@/modules/settings/reservationSettings.service";
import { releaseCalendarDays } from "./reservations.service";
import { logStateChange } from "./stateChange.service";

/**
 * Cancelling a booking.
 *
 * Everything about a cancellation that costs money or sends a message runs
 * through here, so the answer to "what does this cost" is the same whether a
 * guest presses the button, a host does, or support does it on the phone. The
 * old code had three separate cancel paths that each set a state and released
 * a calendar, and none of them touched the money at all.
 *
 * The ladder is the site's own published policy, the one at
 * `/reserve-cancellation-policy` that guests are held to:
 *
 *   تا ۷۲ ساعت مانده به شروع اقامت   کسر ۲۰٪ از مبلغ کل رزرو
 *   کمتر از ۷۲ ساعت                  مبلغ شب اول + ۲۰٪ مابقی شب‌ها
 *   روز شروع اقامت به بعد            دو شب اول + شب‌های سپری شده + ۲۰٪ مابقی
 *
 * Percentages and night counts come from settings so the page and the code can
 * move together; hard-coding them here is how a published promise and the
 * software that keeps it drift apart.
 */

const round = (n: number) => Math.round(n * 100) / 100;
const fa = (n: number) => n.toLocaleString("fa-IR");

export type CancelBand = "EARLY" | "LATE" | "STARTED" | "JUSTIFIED" | "NO_PAYBACK";

export const BAND_LABELS: Record<CancelBand, string> = {
  EARLY: "بیش از ۷۲ ساعت مانده به شروع اقامت",
  LATE: "کمتر از ۷۲ ساعت مانده به شروع اقامت",
  STARTED: "روز شروع اقامت به بعد",
  JUSTIFIED: "کنسلی موجه — بدون کسر",
  NO_PAYBACK: "عدم بازگشت وجه به مشتری",
};

export interface CancelQuote {
  band: CancelBand;
  bandLabel: string;
  /** مبلغ کل اجاره */
  totalAmount: number;
  /** جمع پرداختی مهمان تا این لحظه */
  paidAmount: number;
  /** کسر — what the guest does not get back */
  penalty: number;
  /** بازگشت به مهمان */
  refund: number;
  /** سهم میزبان از این لغو */
  hostShare: number;
  /** سهم سایت از این لغو */
  siteShare: number;
  /** Nights already elapsed at the moment of cancelling. */
  elapsedNights: number;
  /** Nights charged in full by the band. */
  chargedNights: number;
  nightlyRate: number;
  hoursToCheckIn: number;
  /** Plain-language lines the UI shows before anyone presses the button. */
  explanation: string[];
}

interface QuoteInput {
  reservation: {
    startDate: Date;
    endDate: Date;
    daysCount: number;
    totalAmount: number;
    paidAmount: number;
    hostShare: number | null;
    websiteShare: number | null;
    vatAmount: number | null;
  };
  cancelledBy: ReservationCancelledBy;
  justified: boolean;
  withoutPayback: boolean;
  /** Overrides the computed penalty — the long-stay and peak bands are "by agreement". */
  penaltyOverride?: number | null;
  now?: Date;
}

/**
 * Works out the money without changing anything.
 *
 * Deliberately pure and exported: the guest sees this before confirming, the
 * admin sees it in the dialog, and the cancellation itself calls the same
 * function. Three screens agreeing because they ask one function is different
 * from three screens agreeing because someone kept them in step.
 */
export async function quote(input: QuoteInput): Promise<CancelQuote> {
  const settings = await getSettings();
  const r = input.reservation;
  const now = input.now ?? new Date();

  const nights = Math.max(r.daysCount, 1);
  const nightlyRate = round(r.totalAmount / nights);
  const msToStart = r.startDate.getTime() - now.getTime();
  const hoursToCheckIn = Math.round(msToStart / 3_600_000);

  const elapsedNights =
    msToStart > 0
      ? 0
      : Math.min(Math.floor((now.getTime() - r.startDate.getTime()) / 86_400_000), nights);

  let band: CancelBand;
  let penalty: number;
  let chargedNights = 0;

  if (input.withoutPayback) {
    // A decision, not a calculation: the guest gets nothing back.
    band = "NO_PAYBACK";
    penalty = r.paidAmount;
  } else if (input.justified) {
    band = "JUSTIFIED";
    penalty = 0;
  } else if (input.cancelledBy !== "GUEST_CANCELLED") {
    // The ladder exists to price a guest changing their mind. When the host or
    // the site cancels, the guest did nothing wrong and gets everything back —
    // charging them for someone else's decision is the kind of rule that ends
    // up in a complaint rather than a payment.
    band = "JUSTIFIED";
    penalty = 0;
  } else if (msToStart <= 0) {
    band = "STARTED";
    chargedNights = Math.min(settings.cancelNightsStarted + elapsedNights, nights);
    const rest = Math.max(nights - chargedNights, 0);
    penalty = round(
      chargedNights * nightlyRate + (rest * nightlyRate * settings.cancelPenaltyPercent) / 100
    );
  } else if (hoursToCheckIn < settings.cancelEarlyHours) {
    band = "LATE";
    chargedNights = Math.min(settings.cancelNightsLate, nights);
    const rest = Math.max(nights - chargedNights, 0);
    penalty = round(
      chargedNights * nightlyRate + (rest * nightlyRate * settings.cancelPenaltyPercent) / 100
    );
  } else {
    band = "EARLY";
    penalty = round((r.totalAmount * settings.cancelPenaltyPercent) / 100);
  }

  if (input.penaltyOverride != null) {
    penalty = round(Math.max(0, input.penaltyOverride));
  }

  // Never keep more than the guest actually handed over. A penalty larger than
  // the payment is not a debt we can collect, it is a refund of a negative
  // number, and it would land in the ledger as one.
  penalty = round(Math.min(penalty, r.paidAmount));
  const refund = round(Math.max(r.paidAmount - penalty, 0));

  // What is kept gets split the way the booking itself was: the site takes its
  // commission rate on it and the host keeps the rest. The host is the one who
  // held the dates and turned other guests away, so the larger part is theirs.
  const commissionRate =
    r.totalAmount > 0 ? ((r.websiteShare ?? 0) + (r.vatAmount ?? 0)) / r.totalAmount : 0;
  const siteShare = round(penalty * commissionRate);
  const hostShare = round(penalty - siteShare);

  const explanation: string[] = [];
  if (band === "NO_PAYBACK") {
    explanation.push("عدم بازگشت وجه انتخاب شده — کل مبلغ پرداختی نزد سایت می‌ماند.");
  } else if (band === "JUSTIFIED") {
    explanation.push(
      input.cancelledBy === "GUEST_CANCELLED"
        ? "کنسلی موجه — کل مبلغ پرداختی به مهمان برمی‌گردد."
        : "لغو از سمت مهمان نبوده — کل مبلغ پرداختی به مهمان برمی‌گردد."
    );
  } else if (band === "EARLY") {
    explanation.push(
      `${fa(settings.cancelPenaltyPercent)}٪ از مبلغ کل اجاره کسر می‌شود (${round(
        (r.totalAmount * settings.cancelPenaltyPercent) / 100
      ).toLocaleString("fa-IR")} تومان).`
    );
  } else {
    explanation.push(
      `${chargedNights.toLocaleString("fa-IR")} شب کامل کسر می‌شود (${round(
        chargedNights * nightlyRate
      ).toLocaleString("fa-IR")} تومان).`
    );
    const rest = Math.max(nights - chargedNights, 0);
    if (rest > 0) {
      explanation.push(
        `${fa(settings.cancelPenaltyPercent)}٪ از ${rest.toLocaleString("fa-IR")} شب باقی‌مانده کسر می‌شود.`
      );
    }
    if (elapsedNights > 0) {
      explanation.push(`${elapsedNights.toLocaleString("fa-IR")} شب سپری شده در محاسبه لحاظ شد.`);
    }
  }

  if (input.penaltyOverride != null) {
    explanation.push("مبلغ کسر به‌صورت دستی تعیین شده است.");
  }

  if (nights > 14) {
    explanation.push("رزرو بلندمدت (بیش از ۱۴ شب) — طبق مقررات، مبلغ با توافق میزبان تعیین می‌شود.");
  }

  return {
    band,
    bandLabel: BAND_LABELS[band],
    totalAmount: r.totalAmount,
    paidAmount: r.paidAmount,
    penalty,
    refund,
    hostShare,
    siteShare,
    elapsedNights,
    chargedNights,
    nightlyRate,
    hoursToCheckIn,
    explanation,
  };
}

const QUOTE_SELECT = {
  id: true,
  reference: true,
  state: true,
  guestId: true,
  hostId: true,
  residenceId: true,
  startDate: true,
  endDate: true,
  daysCount: true,
  totalAmount: true,
  paidAmount: true,
  hostShare: true,
  websiteShare: true,
  vatAmount: true,
  settledAmount: true,
  clearRemainder: true,
} satisfies Prisma.ReservationSelect;

/** The quote for a booking that exists, by id. */
export async function quoteFor(
  reservationId: number,
  options: {
    cancelledBy: ReservationCancelledBy;
    justified?: boolean;
    withoutPayback?: boolean;
    penaltyOverride?: number | null;
  }
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: QUOTE_SELECT,
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  return quote({
    reservation,
    cancelledBy: options.cancelledBy,
    justified: options.justified ?? false,
    withoutPayback: options.withoutPayback ?? false,
    penaltyOverride: options.penaltyOverride,
  });
}

export interface CancelInput {
  reservationId: number;
  cancelledBy: ReservationCancelledBy;
  /** The picked reason, from the lists the UI offers. */
  reason: string;
  /** Free text, internal. */
  desc?: string | null;
  justified?: boolean;
  withoutPayback?: boolean;
  coordinatedWith?: "guest" | "host" | null;
  notifyMode?: CancelNotifyMode;
  penaltyOverride?: number | null;
  /** Who pressed the button. Null for a guest or host acting on their own booking. */
  actorId?: number | null;
}

/**
 * Cancels a booking and settles what it costs.
 *
 * The order matters. State and money move together in one transaction, so a
 * cancellation can never be half-applied; the calendar and the messages happen
 * after it commits, because a released date that belongs to a cancellation
 * that rolled back is worse than a date released a second late.
 */
export async function cancelReservation(input: CancelInput) {
  const existing = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: QUOTE_SELECT,
  });
  if (!existing) throw AppError.notFound("رزرو پیدا نشد");

  if (existing.state === "CANCEL" || existing.state === "EXPIRED") {
    throw AppError.badRequest("این رزرو قبلاً لغو شده است");
  }

  const money = await quote({
    reservation: existing,
    cancelledBy: input.cancelledBy,
    justified: input.justified ?? false,
    withoutPayback: input.withoutPayback ?? false,
    penaltyOverride: input.penaltyOverride,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.reservation.update({
      where: { id: existing.id },
      data: {
        state: "CANCEL",
        cancelledBy: input.cancelledBy,
        cancelReason: input.reason,
        cancelDesc: input.desc ?? null,
        cancelJustified: input.justified ?? false,
        withoutPayback: input.withoutPayback ?? false,
        cancelCoordinatedWith: input.coordinatedWith ?? null,
        cancelNotifyMode: input.notifyMode ?? "BOTH",
        cancelPenalty: money.penalty,
        cancelRefund: money.refund,
        cancelHostShare: money.hostShare,
        cancelSiteShare: money.siteShare,
        cancelBand: money.band,
        cancelledAt: new Date(),
        cancelledById: input.actorId ?? null,

        // The deposit panel reads these, and after a cancellation the host is
        // owed the cancellation share rather than the original one. Without
        // this the panel would keep offering to pay the full share of a stay
        // that never happened.
        hostShare: money.hostShare,
        clearRemainder: round(Math.max(money.hostShare - existing.settledAmount, 0)),
      },
      select: { id: true, reference: true, guestId: true, hostId: true },
    });

    await logStateChange({
      reservationId: existing.id,
      fromState: existing.state,
      toState: "CANCEL",
      note: input.reason,
      changedById: input.actorId ?? null,
      source: input.actorId ? "CANCEL" : "CANCEL:SYSTEM",
      tx,
    });

    // The guest's money back. There is no payment gateway, so a refund is a
    // wallet credit — the only mechanism that exists to actually give it to
    // them, and one they can then request as a payout.
    if (money.refund > 0) {
      const wallet =
        (await tx.wallet.findUnique({ where: { userId: existing.guestId } })) ??
        (await tx.wallet.create({ data: { userId: existing.guestId } }));

      const balance = round(wallet.balance + money.refund);
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          kind: "BOOKING_REFUND",
          amount: money.refund,
          balanceAfter: balance,
          description: `بازگشت وجه لغو رزرو ${existing.reference}`,
          reservationId: existing.id,
        },
      });
    }

    // The host's income, if it was already credited and held. It was credited
    // for a stay that is not happening, so what is left is the cancellation
    // share and the difference comes back.
    const held = await tx.walletTransaction.findFirst({
      where: { reservationId: existing.id, kind: "BOOKING_INCOME" },
      select: { id: true },
    });

    if (held) {
      const hostWallet = await tx.wallet.findUnique({ where: { userId: existing.hostId } });
      if (hostWallet) {
        const takeBack = round(Math.min((existing.hostShare ?? 0) - money.hostShare, hostWallet.blockedBalance));
        if (takeBack > 0) {
          const blocked = round(hostWallet.blockedBalance - takeBack);
          await tx.wallet.update({ where: { id: hostWallet.id }, data: { blockedBalance: blocked } });
          await tx.walletTransaction.create({
            data: {
              walletId: hostWallet.id,
              kind: "ADJUSTMENT",
              amount: -takeBack,
              balanceAfter: hostWallet.balance,
              description: `اصلاح درآمد بابت لغو رزرو ${existing.reference}`,
              reservationId: existing.id,
            },
          });
        }
      }
    }

    return row;
  });

  await releaseCalendarDays(existing.residenceId, existing.startDate, existing.endDate);

  notifyCancellation(existing.id, input.notifyMode ?? "BOTH");

  return { reservation: updated, money };
}

/**
 * Tells whichever side was chosen.
 *
 * `NONE` is a real answer and the second most common one in Odoo's log after
 * "both": a cancellation already settled by phone does not need a message
 * announcing it, and sending one anyway is how a resolved problem gets
 * reopened.
 */
function notifyCancellation(reservationId: number, mode: CancelNotifyMode) {
  if (mode === "NONE") return;

  // The chat thread always gets the note — it is the record of the booking,
  // not an announcement, and both sides go looking for it there afterwards.
  onReservationStateChanged(reservationId, "BOOKING_CANCELLED");

  notify.onReservationCancelled(reservationId, {
    guest: mode === "BOTH" || mode === "ONLY_GUEST",
    host: mode === "BOTH" || mode === "ONLY_HOST",
  });
}
