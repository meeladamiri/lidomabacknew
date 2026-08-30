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
    const guestUrl = `/profile/my-trips?reservation=${booking.reference}`;
    const hostUrl = `/profile/reserves?reservation=${booking.reference}`;

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
    const guestUrl = `/profile/my-trips?reservation=${booking.reference}`;
    const hostUrl = `/profile/reserves?reservation=${booking.reference}`;
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
      linkUrl: `/profile/residences/${residence.id}`,
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
        residence: { select: { id: true, name: true, hostId: true } },
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
      linkUrl: `/rentals/${review.residence.id}`,
      entityType: "review",
      entityId: review.id,
    });
  });
}
