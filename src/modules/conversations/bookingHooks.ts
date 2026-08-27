/**
 * Where the booking flow touches chat.
 *
 * Every function here swallows its own failures. A reservation is the money
 * path; a thread that failed to open or a status card that failed to post is
 * a problem to fix later, never a reason for a booking to fail. That is also
 * why they are called without being awaited — an SMS provider or a Redis blip
 * must not sit in the middle of a payment flow.
 *
 * The thread is opened when the reservation is *created*, not when it is
 * approved. The gap between request and approval is exactly when a guest has
 * questions and a host needs to ask them.
 */

import { prisma } from "@/lib/prisma";
import { appendSystemMessage, ensureBookingConversation, type SystemMeta } from "./conversations.service";

export function onReservationCreated(reservationId: number): void {
  void ensureBookingConversation(reservationId).catch((error) => {
    console.warn(`[chat] could not open a thread for reservation ${reservationId}:`, error);
  });
}

type StateKind = Extract<
  SystemMeta["kind"],
  "BOOKING_APPROVED" | "BOOKING_CANCELLED" | "BOOKING_EXPIRED" | "BOOKING_COMPLETED"
>;

/**
 * Posts a status card into the reservation's thread.
 *
 * Falls back to opening the thread first: a reservation made before this
 * feature existed has no conversation, and its first status change should not
 * be the thing that discovers that.
 */
export function onReservationStateChanged(
  reservationId: number,
  kind: StateKind,
  extra: Record<string, unknown> = {}
): void {
  void (async () => {
    try {
      const conversation =
        (await prisma.conversation.findUnique({
          where: { bookingId: reservationId },
          select: { id: true },
        })) ?? (await ensureBookingConversation(reservationId));

      await appendSystemMessage(conversation.id, { kind, ...extra });
    } catch (error) {
      console.warn(`[chat] could not post the status change for ${reservationId}:`, error);
    }
  })();
}
