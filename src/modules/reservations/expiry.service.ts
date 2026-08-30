import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { onReservationStateChanged } from "@/modules/conversations/bookingHooks";
import * as notify from "@/modules/notifications/events";
import { releaseCalendarDays } from "./reservations.service";
import { deadlineIn, getSettings } from "@/modules/settings/reservationSettings.service";

/**
 * Expiring bookings nobody acted on.
 *
 * The pieces for this were already written and never connected: `expiryDate`
 * was a column nothing populated, `EXPIRED` a state nothing produced, and both
 * the "رزرو منقضی شد" notification and its chat message sat behind a branch
 * that could not be reached. Meanwhile a booking a host ignored held its dates
 * off sale forever — the cost of the gap fell on the listing, silently.
 */

/**
 * Expires everything past its deadline and puts the dates back on sale.
 *
 * Bookings with no deadline are left alone. Every reservation that predates
 * this feature has a null `expiryDate`, and sweeping those would expire a year
 * of history on the first run — which is a migration, not a maintenance job,
 * and not one to perform by accident.
 */
export async function expireOverdue(limit = 200) {
  const due = await prisma.reservation.findMany({
    where: {
      state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT"] },
      expiryDate: { not: null, lt: new Date() },
    },
    select: { id: true, residenceId: true, startDate: true, endDate: true },
    take: limit,
  });

  let expired = 0;

  for (const reservation of due) {
    try {
      // The state change is conditional on the state not having moved: a host
      // accepting at the same moment the sweep runs must win, and a booking
      // must never be expired out from under a payment.
      const { count } = await prisma.reservation.updateMany({
        where: { id: reservation.id, state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT"] } },
        data: { state: "EXPIRED" },
      });

      if (count === 0) continue;

      await releaseCalendarDays(reservation.residenceId, reservation.startDate, reservation.endDate);

      // Both sides are told. Either of them can be the one who did not know:
      // the guest who never heard back, or the host who never noticed.
      onReservationStateChanged(reservation.id, "BOOKING_EXPIRED");
      notify.onReservationStateChanged(reservation.id, "BOOKING_EXPIRED");

      expired++;
    } catch (error) {
      // One bad booking must not stop the sweep — the rest are still holding
      // dates that are not being sold.
      console.error(
        `[expire] reservation ${reservation.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { checked: due.length, expired };
}

/**
 * Moves one booking's deadline, from the admin panel.
 *
 * Odoo let this be edited per sale order and support needs the same thing: a
 * host who called to say they are on their way should not lose the booking to
 * a clock. Accepts either an absolute moment or "n minutes from now", because
 * the two ways people ask for it are "until 6pm" and "give them another hour".
 */
export async function setExpiry(
  id: number,
  input: { expiryDate?: Date | null; minutesFromNow?: number }
) {
  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: { id },
    select: { id: true, state: true },
  });

  if (reservation.state !== "HOST_APPROVAL" && reservation.state !== "SECOND_PAYMENT") {
    throw AppError.badRequest("این رزرو در وضعیتی نیست که مهلت داشته باشد");
  }

  const expiryDate =
    input.minutesFromNow != null ? deadlineIn(input.minutesFromNow) : (input.expiryDate ?? null);

  if (expiryDate && expiryDate.getTime() < Date.now()) {
    // Setting a deadline in the past is a way of cancelling that leaves no
    // reason behind. Cancelling is its own action, and it asks for one.
    throw AppError.badRequest("مهلت نمی‌تواند در گذشته باشد");
  }

  return prisma.reservation.update({
    where: { id },
    data: { expiryDate },
    select: { id: true, reference: true, state: true, expiryDate: true },
  });
}

/** The site-wide defaults, for the panel to show next to the field. */
export async function defaultWindows() {
  const { approvalWindowMinutes, paymentWindowMinutes } = await getSettings();
  return { approvalWindowMinutes, paymentWindowMinutes };
}
