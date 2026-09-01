// Where the rest of the app turns an event into a notification.
//
// Same contract as conversations/bookingHooks.ts, and for the same reason:
// every function swallows its own failures and is called without being
// awaited. A reservation is the money path. A notification that failed to
// write is a bug to fix; it is never a reason for a booking to fail, and an
// extra database round-trip must not sit inside a payment flow.
//
// Text is rendered here, at write time, and stored. A booking's dates can
// change afterwards, and "your stay was approved" has to keep saying what it
// said when it was sent.

import { prisma } from "@/lib/prisma";
import { record } from "./notifications.service";
import { publicResidenceId } from "@/lib/publicId";

const fa = (n: number) => n.toLocaleString("fa-IR");

function nights(start: Date, end: Date): number {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

/** Jalali, the way every other date on the site is shown. */
function faDate(d: Date): string {
  return new Intl.DateTimeFormat("fa-IR", {
    day: "numeric",
    month: "long",
  }).format(d);
}

async function loadBooking(reservationId: number) {
  return prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      reference: true,
      guestId: true,
      hostId: true,
      startDate: true,
      endDate: true,
      guestsCount: true,
      residence: { select: { id: true, name: true } },
      guest: { select: { name: true } },
    },
  });
}

/**
 * Where a notification about a booking should send each side.
 *
 * Every one of these pointed at /profile/my-trips and /profile/reserves with
 * the reference in a query string. Neither route exists — the pages are
 * /my-trips/<id> and /reservations/<id>, and neither reads a `reservation`
 * query parameter — so every booking notification ever sent led to a 404.
 *
 * The id, not the reference: that is what both detail pages take.
 */
const guestLink = (reservationId: number) => `/my-trips/${reservationId}`;
const hostLink = (reservationId: number) => `/reservations/${reservationId}`;

function fire(label: string, run: () => Promise<unknown>): void {
  void run().catch((error) => {
    console.warn(`[notifications] ${label} failed:`, error);
  });
}

/**
 * A new request: the guest gets a receipt, the host gets something to act on.
 *
 * Two different notifications for one event — the host needs to approve, the
 * guest needs to know it went through. Sending one shared line would leave one
 * of them reading a message written for the other.
 */
export function onReservationCreated(reservationId: number): void {
  fire(`created ${reservationId}`, async () => {
    const booking = await loadBooking(reservationId);
    if (!booking) return;

    const stay = `${faDate(booking.startDate)} تا ${faDate(booking.endDate)}`;
    const guestUrl = guestLink(booking.id);
    const hostUrl = hostLink(booking.id);

    await Promise.all([
      record({
        userId: booking.guestId,
        kind: "BOOKING_REQUESTED",
        title: "درخواست رزرو ثبت شد",
        body: `درخواست شما برای ${booking.residence.name} (${stay}) ثبت شد و در انتظار تأیید میزبان است.`,
        linkUrl: guestUrl,
        entityType: "reservation",
        entityId: booking.id,
      }),
      record({
        userId: booking.hostId,
        kind: "BOOKING_NEW_REQUEST",
        title: "درخواست رزرو جدید",
        body: `${booking.guest?.name || "یک مهمان"} برای ${booking.residence.name} در تاریخ ${stay} درخواست رزرو داده است.`,
        linkUrl: hostUrl,
        entityType: "reservation",
        entityId: booking.id,
      }),
    ]);
  });
}

type StateKind = "BOOKING_APPROVED" | "BOOKING_CANCELLED" | "BOOKING_EXPIRED" | "BOOKING_COMPLETED";

/**
 * A status change. Who hears about it depends on what happened.
 *
 * An approval is news for the guest — the host is the one who did it, and
 * telling someone what they just did themselves is noise. A cancellation goes
 * to both, because either side can be the one who did not do it.
 */
export function onReservationStateChanged(reservationId: number, kind: StateKind): void {
  fire(`state ${kind} ${reservationId}`, async () => {
    const booking = await loadBooking(reservationId);
    if (!booking) return;

    const stay = `${faDate(booking.startDate)} تا ${faDate(booking.endDate)}`;
    const nightCount = nights(booking.startDate, booking.endDate);
    const guestUrl = guestLink(booking.id);
    const hostUrl = hostLink(booking.id);
    const name = booking.residence.name;

    if (kind === "BOOKING_APPROVED") {
      await record({
        userId: booking.guestId,
        kind: "BOOKING_APPROVED",
        title: "رزرو شما تأیید شد",
        body: `میزبان ${name} درخواست شما برای ${fa(nightCount)} شب (${stay}) را تأیید کرد.`,
        linkUrl: guestUrl,
        entityType: "reservation",
        entityId: booking.id,
      });
      return;
    }

    if (kind === "BOOKING_COMPLETED") {
      await record({
        userId: booking.guestId,
        kind: "BOOKING_COMPLETED",
        title: "سفرتان تمام شد",
        body: `امیدواریم اقامتتان در ${name} خوب بوده باشد. ثبت نظر به مهمان‌های بعدی کمک می‌کند.`,
        linkUrl: guestUrl,
        entityType: "reservation",
        entityId: booking.id,
      });
      return;
    }

    const title = kind === "BOOKING_EXPIRED" ? "رزرو منقضی شد" : "رزرو لغو شد";
    const body =
      kind === "BOOKING_EXPIRED"
        ? `درخواست رزرو ${name} (${stay}) در مهلت مقرر تأیید نشد و منقضی شد.`
        : `رزرو ${name} (${stay}) لغو شد.`;

    await Promise.all([
      record({
        userId: booking.guestId,
        kind,
        title,
        body,
        linkUrl: guestUrl,
        entityType: "reservation",
        entityId: booking.id,
      }),
      record({
        userId: booking.hostId,
        kind,
        title,
        body,
        linkUrl: hostUrl,
        entityType: "reservation",
        entityId: booking.id,
      }),
    ]);
  });
}

/**
 * A published or rejected listing.
 *
 * Rejection carries the reason: a host told only "rejected" has to open a
 * ticket to find out what to change, which is a support cost for both sides.
 */
export function onResidenceReviewed(
  residenceId: number,
  published: boolean,
  reason?: string | null
): void {
  fire(`residence ${residenceId}`, async () => {
    const residence = await prisma.residence.findUnique({
      where: { id: residenceId },
      select: { id: true, name: true, hostId: true },
    });
    if (!residence?.hostId) return;

    await record({
      userId: residence.hostId,
      kind: published ? "RESIDENCE_PUBLISHED" : "RESIDENCE_REJECTED",
      title: published ? "اقامتگاه شما منتشر شد" : "اقامتگاه شما تأیید نشد",
      body: published
        ? `${residence.name} تأیید شد و اکنون در نتایج جستجو دیده می‌شود.`
        : `${residence.name} تأیید نشد.${reason ? ` دلیل: ${reason}` : " برای جزئیات با پشتیبانی در تماس باشید."}`,
      // /residences has no index page — the host list is /residences/list.
        linkUrl: "/residences/list",
      entityType: "residence",
      entityId: residence.id,
    });
  });
}

/** A review left on a host's listing. */
export function onReviewCreated(reviewId: number): void {
  fire(`review ${reviewId}`, async () => {
    const review = await prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        averageRating: true,
        residence: { select: { id: true, name: true, hostId: true, reference: true } },
      },
    });
    if (!review?.residence?.hostId) return;

    await record({
      userId: review.residence.hostId,
      kind: "REVIEW_RECEIVED",
      title: "نظر جدید",
      body: `یک مهمان برای ${review.residence.name} نظر ثبت کرد${
        review.averageRating ? ` و امتیاز ${fa(Math.round(review.averageRating * 10) / 10)} داد` : ""
      }.`,
      linkUrl: `/rentals/${publicResidenceId(review.residence)}`,
      entityType: "review",
      entityId: review.id,
    });
  });
}

/**
 * A cancellation, told to whichever side was chosen.
 *
 * Separate from `onReservationStateChanged` because a cancellation is the one
 * event where "who hears about it" is a decision rather than a rule. Support
 * settles a cancellation on the phone and then does not want the system
 * announcing it to the person they just spoke to — that is how a resolved
 * problem gets reopened.
 *
 * The reason is carried into the text. A host reading "رزرو لغو شد" with no
 * cause opens a support ticket to ask why, which costs more than the sentence.
 */
export function onReservationCancelled(
  reservationId: number,
  targets: { guest: boolean; host: boolean }
): void {
  if (!targets.guest && !targets.host) return;

  fire(`cancelled ${reservationId}`, async () => {
    const booking = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        reference: true,
        guestId: true,
        hostId: true,
        startDate: true,
        endDate: true,
        cancelReason: true,
        cancelledBy: true,
        cancelJustified: true,
        cancelRefund: true,
        residence: { select: { name: true } },
      },
    });
    if (!booking) return;

    const stay = `${faDate(booking.startDate)} تا ${faDate(booking.endDate)}`;
    const name = booking.residence.name;
    const who =
      booking.cancelledBy === "HOST_CANCELLED"
        ? "میزبان"
        : booking.cancelledBy === "GUEST_CANCELLED"
          ? "مهمان"
          : "پشتیبانی لیدوما";

    const reason = booking.cancelReason ? ` دلیل: ${booking.cancelReason}` : "";

    const writes: Promise<unknown>[] = [];

    if (targets.guest) {
      // The refund is the guest's first question, so it is in the notification
      // rather than one screen further in.
      const refund =
        booking.cancelRefund && booking.cancelRefund > 0
          ? ` مبلغ ${fa(booking.cancelRefund)} تومان به کیف پول شما بازگردانده شد.`
          : "";

      writes.push(
        record({
          userId: booking.guestId,
          kind: "BOOKING_CANCELLED",
          title: "رزرو لغو شد",
          body: `رزرو ${name} (${stay}) توسط ${who} لغو شد.${reason}${refund}`,
          linkUrl: guestLink(booking.id),
          entityType: "reservation",
          entityId: booking.id,
        })
      );
    }

    if (targets.host) {
      writes.push(
        record({
          userId: booking.hostId,
          kind: "BOOKING_CANCELLED",
          title: "رزرو لغو شد",
          body: `رزرو ${name} (${stay}) توسط ${who} لغو شد.${reason} تاریخ‌های این رزرو دوباره آزاد شدند.`,
          linkUrl: hostLink(booking.id),
          entityType: "reservation",
          entityId: booking.id,
        })
      );
    }

    await Promise.all(writes);
  });
}
