import { Prisma, type ReservationState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { deadlineIn, getSettings } from "@/modules/settings/reservationSettings.service";
import * as walletService from "@/modules/wallet/wallet.service";
import * as reservationSettings from "@/modules/settings/reservationSettings.service";
import * as notify from "@/modules/notifications/events";
import { onReservationStateChanged } from "@/modules/conversations/bookingHooks";
import { releaseCalendarDays } from "./reservations.service";
import * as activity from "@/modules/activity/activity.service";

/**
 * Moving a booking between states by hand.
 *
 * The panel could previously only push a booking forwards, one button per
 * step, and never back: a support agent who advanced the wrong booking had no
 * way to undo it. What it also never asked was *why* — so the state said where
 * a booking was and nothing said how it got there.
 *
 * Every move now carries a note and lands in `reservation_state_changes`,
 * automatic moves included. A timeline showing only what people did, with the
 * system's own transitions missing, reads as though nothing happened between
 * them.
 */

export const STATE_LABELS: Record<ReservationState, string> = {
  DRAFT: "در انتظار ثبت درخواست",
  HOST_APPROVAL: "در انتظار تایید میزبان",
  SECOND_PAYMENT: "در انتظار پرداخت مهمان",
  DONE: "قطعی",
  CANCEL: "لغو شده",
  EXPIRED: "منقضی شده",
};

/**
 * Which moves a person may make.
 *
 * Forward and back along the booking's own path, because correcting a mistake
 * is the reason this exists. Two rules are deliberate:
 *
 *   - Nothing may be moved *out* of CANCEL. Cancelling refunds money, reverses
 *     host income and rewrites what the deposit panel owes; putting a booking
 *     back would need all of that undone, and silently leaving it done is how
 *     a host gets paid twice. Re-book instead.
 *   - Nothing may be moved *into* CANCEL from here. Cancelling needs a
 *     canceller, a justification and a notification choice — a plain note
 *     cannot carry them, so that lives in its own dialog.
 */
const ALLOWED: Record<ReservationState, ReservationState[]> = {
  DRAFT: ["HOST_APPROVAL"],
  HOST_APPROVAL: ["DRAFT", "SECOND_PAYMENT", "EXPIRED"],
  SECOND_PAYMENT: ["HOST_APPROVAL", "DONE", "EXPIRED"],
  DONE: ["SECOND_PAYMENT"],
  EXPIRED: ["HOST_APPROVAL", "SECOND_PAYMENT"],
  CANCEL: [],
};

export function allowedTransitions(from: ReservationState): ReservationState[] {
  return ALLOWED[from] ?? [];
}

/**
 * Writes the audit line. Called by hand-made and automatic transitions alike.
 *
 * Never throws into its caller: a booking that moved must not be rolled back
 * because its history entry failed. It is written inside the same transaction
 * where one is available, and best-effort where one is not.
 */
export async function logStateChange(input: {
  reservationId: number;
  fromState: ReservationState | null;
  toState: ReservationState;
  note?: string | null;
  changedById?: number | null;
  changedByName?: string | null;
  source?: string;
  /** The surrounding transaction, when the caller has one. */
  tx?: Prisma.TransactionClient;
}) {
  const data = {
    reservationId: input.reservationId,
    fromState: input.fromState,
    toState: input.toState,
    note: input.note ?? null,
    changedById: input.changedById ?? null,
    changedByName: input.changedByName ?? null,
    source: input.source ?? "MANUAL",
  };

  try {
    if (input.tx) {
      await input.tx.reservationStateChange.create({ data });
    } else {
      await prisma.reservationStateChange.create({ data });
    }

    // The same event, in the one timeline the panel reads. Written here rather
    // than at each call site, so no transition can reach the state table and
    // miss the log.
    activity.log({
      kind: "STATE_CHANGE",
      reservationId: input.reservationId,
      summary:
        (input.fromState ? `${STATE_LABELS[input.fromState]} ← ` : "") +
        STATE_LABELS[input.toState] +
        (input.note ? ` — ${input.note}` : ""),
      details: {
        from: input.fromState,
        to: input.toState,
        note: input.note ?? null,
      } as never,
      actorId: input.changedById,
      actorName: input.changedByName,
      source: input.source ?? "MANUAL",
    });
  } catch (error) {
    console.warn(
      `[state-log] reservation ${input.reservationId} → ${input.toState} not logged:`,
      error instanceof Error ? error.message : error
    );
  }
}

export interface ChangeStateInput {
  reservationId: number;
  toState: ReservationState;
  /** Required. The sentence a person had to write before the state would move. */
  note: string;
  actorId: number;
}

/**
 * Applies a manual state change, with whatever that state actually implies.
 *
 * The side effects are the point. A booking dragged to «قطعی» has to pay the
 * host the same way the ordinary path does, or the panel becomes a way to
 * create bookings the money never hears about.
 */
export async function changeState(input: ChangeStateInput) {
  const note = input.note?.trim();
  if (!note) throw AppError.badRequest("توضیح تغییر وضعیت الزامی است");

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: {
      id: true,
      reference: true,
      state: true,
      hostId: true,
      guestId: true,
      residenceId: true,
      startDate: true,
      endDate: true,
      totalAmount: true,
      guestCommission: true,
      hostShare: true,
    },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const from = reservation.state;
  const to = input.toState;

  if (from === to) throw AppError.badRequest("رزرو همین الان در این وضعیت است");

  if (to === "CANCEL") {
    throw AppError.badRequest("برای لغو رزرو از فرم «لغو رزرو» استفاده کنید");
  }

  if (!allowedTransitions(from).includes(to)) {
    throw AppError.badRequest(
      `تغییر وضعیت از «${STATE_LABELS[from]}» به «${STATE_LABELS[to]}» مجاز نیست`
    );
  }

  const actor = await prisma.user.findUnique({
    where: { id: input.actorId },
    select: { name: true, phone: true },
  });
  const actorName = actor?.name || actor?.phone || `ادمین #${input.actorId}`;

  const settings = await getSettings();

  // Each state carries its own deadline, and moving into one has to set it —
  // otherwise a booking pushed back to «در انتظار تایید میزبان» keeps a
  // deadline that already passed and the expiry sweep takes it straight back.
  const data: Record<string, unknown> = { state: to };

  if (to === "HOST_APPROVAL") {
    data.expiryDate = deadlineIn(settings.approvalWindowMinutes);
  } else if (to === "SECOND_PAYMENT") {
    data.expiryDate = deadlineIn(settings.paymentWindowMinutes);
  } else if (to === "DRAFT" || to === "DONE" || to === "EXPIRED") {
    data.expiryDate = null;
  }

  if (to === "DONE") {
    data.paidAmount = reservation.totalAmount + (reservation.guestCommission ?? 0);
    data.remainingAmount = 0;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.reservation.update({
      where: { id: reservation.id },
      data,
      select: { id: true, state: true, reference: true, hostShare: true },
    });

    await logStateChange({
      reservationId: reservation.id,
      fromState: from,
      toState: to,
      note,
      changedById: input.actorId,
      changedByName: actorName,
      source: "MANUAL",
      tx,
    });

    return row;
  });

  // Reaching «قطعی» by hand owes the host exactly what reaching it the
  // ordinary way does. Awaited, and outside the transaction only because the
  // wallet runs its own — a failure here leaves a state change that a second
  // attempt will complete, which beats a booking that will not move at all.
  if (to === "DONE") {
    let share = reservation.hostShare;

    if (share == null) {
      const split = await reservationSettings.breakdownForHost(
        reservation.hostId,
        reservation.totalAmount
      );
      share = split.hostShare;
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          websiteShare: split.websiteShare,
          vatAmount: split.vatAmount,
          hostShare: split.hostShare,
          commissionPercent: split.commissionPercent,
          vatPercent: split.vatPercent,
          clearRemainder: split.hostShare,
        },
      });
    }

    if (share && share > 0) {
      const already = await prisma.walletTransaction.findFirst({
        where: { reservationId: reservation.id, kind: "BOOKING_INCOME" },
        select: { id: true },
      });

      // Moving back and forth between «پرداخت مهمان» and «قطعی» must not pay
      // the host once per round trip.
      if (!already) {
        await walletService.credit({
          userId: reservation.hostId,
          kind: "BOOKING_INCOME",
          amount: share,
          description: `درآمد رزرو ${reservation.reference}`,
          reservationId: reservation.id,
          blocked: true,
        });
      }
    }
  }

  // Going back to a pre-booking state hands the dates back, because a booking
  // that is no longer live must not keep a calendar blocked.
  if (to === "DRAFT" || to === "EXPIRED") {
    await releaseCalendarDays(reservation.residenceId, reservation.startDate, reservation.endDate);
  }

  if (to === "SECOND_PAYMENT" && from === "HOST_APPROVAL") {
    onReservationStateChanged(reservation.id, "BOOKING_APPROVED");
    notify.onReservationStateChanged(reservation.id, "BOOKING_APPROVED");
  }

  if (to === "DONE") {
    notify.onReservationStateChanged(reservation.id, "BOOKING_COMPLETED");
  }

  return {
    reservation: updated,
    from,
    to,
    label: STATE_LABELS[to],
  };
}

/** The booking's history, newest first. */
export async function history(reservationId: number) {
  const rows = await prisma.reservationStateChange.findMany({
    where: { reservationId },
    orderBy: { id: "desc" },
    take: 100,
  });

  return rows.map((r) => ({
    id: r.id,
    from_state: r.fromState,
    from_label: r.fromState ? STATE_LABELS[r.fromState] : null,
    to_state: r.toState,
    to_label: STATE_LABELS[r.toState],
    note: r.note,
    changed_by: r.changedByName,
    source: r.source,
    created_at: r.createdAt,
  }));
}
