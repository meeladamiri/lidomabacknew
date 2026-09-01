import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { onReservationCreated, onReservationStateChanged } from "@/modules/conversations/bookingHooks";
import * as notify from "@/modules/notifications/events";
import { nextReservationReference } from "@/utils/reference";
import { calculateStayPrice } from "./pricing";
import {
  computeBreakdown,
  deadlineIn,
  getSettings,
  ratesForHost,
} from "@/modules/settings/reservationSettings.service";
import { resolvePublicResidenceId } from "@/lib/publicId";

export const RESERVATION_INCLUDE = {
  residence: {
    select: {
      id: true,
      name: true,
      reference: true,
      type: true,
      address: true,
      neighborhood: true,
      latitude: true,
      longitude: true,
      capacity: true,
      maxCapacity: true,
      averageRating: true,
      reviewsCount: true,
      minReservableDays: true,
      checkinFrom: true,
      checkinTo: true,
      checkout: true,
      beforeStartTime: true,
      fullReturnTime: true,
      hostShareTotalAmount: true,
      hostSharePastNights: true,
      hostShareFutureNights: true,
      location: {
        select: {
          name: true,
          titleEn: true,
          parent: { select: { name: true, type: true } },
        },
      },
      images: {
        take: 1,
        orderBy: {
          sortOrder: "asc" as const,
        },
      },
      rules: {
        include: { rule: true },
      },
    },
  },
  guest: {
    select: {
      id: true,
      name: true,
      phone: true,
      avatarUrl: true,
    },
  },
  host: {
    select: {
      id: true,
      name: true,
      phone: true,
      avatarUrl: true,
    },
  },
  rooms: {
    include: {
      room: {
        select: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  },
  review: true,
} satisfies Prisma.ReservationInclude;

export async function createReservation(
  guestId: number,
  data: {
    residenceId: number;
    roomIds?: number[];
    startDate: string;
    endDate: string;
    guestsCount: number;
    extraGuestsCount?: number;
    guestNameOverride?: string;
    guestPhoneOverride?: string;
  }
) {
  const residence = await prisma.residence.findFirst({
    where: {
      // legacy-URL contract: the page carries the Odoo id for migrated
      // residences (see lib/publicId.ts)
      id: await resolvePublicResidenceId(data.residenceId),
    },
    select: {
      id: true,
      state: true,
      published: true,
      hostId: true,
      weekPrice: true,
      weekendPrice: true,
      peakPrice: true,
      extraGuestsPrice: true,
      weeklyDiscount: true,
      monthlyDiscount: true,
      maxCapacity: true,
    },
  });

  if (!residence) {
    throw AppError.notFound("اقامتگاه یافت نشد");
  }

  // A deactivated listing still has a page, so a guest can still reach this
  // endpoint from it — with a stale tab, or by posting straight to the API.
  // The gate belongs here, and it needs to say what actually happened rather
  // than claim the residence does not exist.
  if (residence.state === "DEACTIVATED") {
    throw AppError.badRequest("این اقامتگاه در حال حاضر پذیرای مهمان نیست و امکان رزرو ندارد");
  }

  if (residence.state !== "PUBLISHED" || !residence.published) {
    throw AppError.notFound("اقامتگاه یافت نشد");
  }

  if (residence.hostId === guestId) {
    throw AppError.badRequest("امکان رزرو اقامتگاه خودتان وجود ندارد");
  }

  if (residence.maxCapacity && data.guestsCount > residence.maxCapacity) {
    throw AppError.badRequest(
      "تعداد مهمانان بیشتر از ظرفیت اقامتگاه است",
      "CAPACITY_EXCEEDED"
    );
  }

  const startDate = new Date(data.startDate);
  const endDate = new Date(data.endDate);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw AppError.badRequest("تاریخ ورود یا خروج نامعتبر است");
  }

  if (endDate <= startDate) {
    throw AppError.badRequest("تاریخ خروج باید بعد از تاریخ ورود باشد");
  }

  const overlapping = await prisma.calendarDay.findMany({
    where: {
      residenceId: residence.id,
      roomId: null,
      date: {
        gte: startDate,
        lt: endDate,
      },
      isBlocked: true,
    },
  });

  if (overlapping.length > 0) {
    throw AppError.conflict(
      "این بازه تاریخی برای اقامتگاه در دسترس نیست",
      "DATES_UNAVAILABLE"
    );
  }

  const overrides = await prisma.calendarDay.findMany({
    where: {
      residenceId: residence.id,
      roomId: null,
      date: {
        gte: startDate,
        lt: endDate,
      },
    },
    select: {
      date: true,
      specialPrice: true,
      isPeak: true,
    },
  });

  const pricing = calculateStayPrice({
    residence,
    calendarOverrides: overrides,
    startDate,
    endDate,
    extraGuestsCount: data.extraGuestsCount ?? 0,
  });

  // The commission split is worked out once, here, and stored on the booking.
  // Reading the rate again later would mean a settings change silently
  // restating what a host was owed on a stay that already happened. The same
  // read supplies the approval window, so both come from one snapshot of the
  // settings rather than two that could differ.
  const rates = await ratesForHost(residence.hostId);
  const money = computeBreakdown(pricing.totalAmount, rates);

  const reservation = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // بررسی مجدد ظرفیت در تراکنش برای جلوگیری از تداخل همزمان
      const stillBlocked = await tx.calendarDay.findMany({
        where: {
          residenceId: residence.id,
          roomId: null,
          date: {
            gte: startDate,
            lt: endDate,
          },
          isBlocked: true,
        },
      });

      if (stillBlocked.length > 0) {
        throw AppError.conflict(
          "این بازه تاریخی همین الان توسط شخص دیگری رزرو شد",
          "DATES_UNAVAILABLE"
        );
      }

      const created = await tx.reservation.create({
        data: {
          reference: await nextReservationReference(tx),
          residenceId: residence.id,
          guestId,
          hostId: residence.hostId,
          startDate,
          endDate,
          daysCount: pricing.nights,
          guestsCount: data.guestsCount,
          extraGuestsCount: data.extraGuestsCount ?? 0,
          totalAmount: pricing.totalAmount,
          websiteShare: money.websiteShare,
          vatAmount: money.vatAmount,
          guestCommission: money.guestCommission,
          hostShare: money.hostShare,
          commissionPercent: money.commissionPercent,
          vatPercent: money.vatPercent,
          guestCommissionPercent: money.guestCommissionPercent,
          // What the guest still owes: the rent plus the site's guest fee.
          // Nothing has been paid at this point — there is no gateway yet.
          remainingAmount: money.guestPayable,
          // مهلت تایید میزبان. Stored on the booking rather than computed from
          // createdAt on read, so support can extend one booking's deadline
          // without moving everybody else's.
          expiryDate: deadlineIn(rates.approvalWindowMinutes),
          guestNameOverride: data.guestNameOverride,
          guestPhoneOverride: data.guestPhoneOverride,
          state: "HOST_APPROVAL",
          rooms: data.roomIds
            ? {
                create: data.roomIds.map((roomId) => ({
                  roomId,
                })),
              }
            : undefined,
        },
        include: RESERVATION_INCLUDE,
      });

      const days: Array<{
        residenceId: number;
        roomId: number | null;
        date: Date;
        isBlocked: boolean;
      }> = [];

      let cursor = new Date(startDate);

      while (cursor < endDate) {
        days.push({
          residenceId: residence.id,
          roomId: null,
          date: new Date(cursor),
          isBlocked: true,
        });

        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      }

      // Can't use upsert's compound-unique `where` here — Prisma/Postgres unique
      // lookups don't match on NULL, and `roomId` is null for whole-residence days.
      // Batched into 3 queries total (instead of one findFirst+create/update per day)
      // so this doesn't blow the transaction timeout against a remote DB.
      const existingDays = await tx.calendarDay.findMany({
        where: {
          residenceId: residence.id,
          roomId: null,
          date: { in: days.map((d) => d.date) },
        },
        select: { id: true, date: true },
      });
      const existingIds = existingDays.map((d) => d.id);
      const existingDates = new Set(existingDays.map((d) => d.date.getTime()));
      const newDays = days.filter((d) => !existingDates.has(d.date.getTime()));

      if (existingIds.length > 0) {
        await tx.calendarDay.updateMany({
          where: { id: { in: existingIds } },
          data: { isBlocked: true },
        });
      }
      if (newDays.length > 0) {
        await tx.calendarDay.createMany({
          data: newDays.map((day) => ({
            residenceId: day.residenceId,
            roomId: day.roomId,
            date: day.date,
            isBlocked: day.isBlocked,
          })),
        });
      }

      return created;
    },
    { timeout: 15000 }
  );

  // Opens the host <-> guest thread with a summary of what was just booked.
  // Detached: chat is never a reason a booking fails.
  onReservationCreated(reservation.id);
  notify.onReservationCreated(reservation.id);

  return {
    reservation,
    pricing,
  };
}

export async function listGuestReservations(guestId: number) {
  return prisma.reservation.findMany({
    where: {
      guestId,
    },
    include: RESERVATION_INCLUDE,
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function listHostReservations(hostId: number) {
  return prisma.reservation.findMany({
    where: {
      hostId,
    },
    include: RESERVATION_INCLUDE,
    orderBy: {
      createdAt: "desc",
    },
  });
}

async function getOwnedReservation(
  userId: number,
  id: number,
  role: "guest" | "host" | "either" = "either"
) {
  const reservation = await prisma.reservation.findUnique({
    where: {
      id,
    },
    include: RESERVATION_INCLUDE,
  });

  if (!reservation) {
    throw AppError.notFound("رزرو یافت نشد");
  }

  const isGuest = reservation.guestId === userId;
  const isHost = reservation.hostId === userId;

  if (role === "guest" && !isGuest) {
    throw AppError.forbidden();
  }

  if (role === "host" && !isHost) {
    throw AppError.forbidden();
  }

  if (role === "either" && !isGuest && !isHost) {
    throw AppError.forbidden();
  }

  return reservation;
}

export async function getReservationDetail(userId: number, id: number) {
  return getOwnedReservation(userId, id, "either");
}

export async function releaseCalendarDays(
  residenceId: number,
  startDate: Date,
  endDate: Date
) {
  await prisma.calendarDay.updateMany({
    where: {
      residenceId,
      roomId: null,
      date: {
        gte: startDate,
        lt: endDate,
      },
    },
    data: {
      isBlocked: false,
    },
  });
}

export async function acceptReservation(hostId: number, id: number) {
  const reservation = await getOwnedReservation(hostId, id, "host");

  if (reservation.state !== "HOST_APPROVAL") {
    throw AppError.badRequest("این رزرو در وضعیت قابل تایید نیست");
  }

  // The clock restarts here: the host has answered, and the remaining wait is
  // the guest's. Leaving the approval deadline in place would hand the guest
  // whatever minutes the host happened not to use.
  const { paymentWindowMinutes } = await getSettings();

  const accepted = await prisma.reservation.update({
    where: {
      id,
    },
    data: {
      state: "SECOND_PAYMENT",
      expiryDate: deadlineIn(paymentWindowMinutes),
    },
    include: RESERVATION_INCLUDE,
  });

  onReservationStateChanged(id, "BOOKING_APPROVED");

  notify.onReservationStateChanged(id, "BOOKING_APPROVED");

  return accepted;
}

export async function rejectReservation(
  hostId: number,
  id: number,
  reason: string,
  desc?: string
) {
  const reservation = await getOwnedReservation(hostId, id, "host");

  if (reservation.state !== "HOST_APPROVAL") {
    throw AppError.badRequest("این رزرو در وضعیت قابل رد شدن نیست");
  }

  const { cancelReservation } = await import("./cancellation.service");

  // A host cancelling a booking the guest already paid for is not the guest's
  // fault, so the ladder does not apply and the refund is whole. The service
  // decides that from `cancelledBy` rather than from a flag passed in here.
  const result = await cancelReservation({
    reservationId: id,
    cancelledBy: "HOST_CANCELLED",
    reason: reason ?? "لغو توسط میزبان",
    desc,
    notifyMode: "BOTH",
    actorId: hostId,
  });

  return prisma.reservation.findUniqueOrThrow({
    where: { id: result.reservation.id },
    include: RESERVATION_INCLUDE,
  });
}

export async function hostCancelReservation(
  hostId: number,
  id: number,
  reason?: string,
  desc?: string
) {
  const reservation = await getOwnedReservation(hostId, id, "host");

  if (reservation.state === "CANCEL" || reservation.state === "DONE") {
    throw AppError.badRequest("این رزرو قابل لغو نیست");
  }

  const updated = await prisma.reservation.update({
    where: {
      id,
    },
    data: {
      state: "CANCEL",
      cancelledBy: "HOST_CANCELLED",
      cancelReason: reason,
      cancelDesc: desc,
    },
    include: RESERVATION_INCLUDE,
  });

  await releaseCalendarDays(
    reservation.residenceId,
    reservation.startDate,
    reservation.endDate
  );

  // cancelledBy comes off the updated row rather than the call site, so all
  // three cancellation paths — host reject, host cancel, guest cancel — post
  // the same card and it always names the right side.
  onReservationStateChanged(id, "BOOKING_CANCELLED", {
    reason: updated.cancelReason,
    cancelledBy: updated.cancelledBy,
  });
  notify.onReservationStateChanged(id, "BOOKING_CANCELLED");

  return updated;
}

// ---------- Reviews ----------

interface ReviewScores {
  cleaning: number;
  location: number;
  quality: number;
  integrity: number;
  greeting: number;
  delivery: number;
}

async function recomputeResidenceRating(residenceId: number) {
  const agg = await prisma.review.aggregate({
    where: { residenceId },
    _avg: { averageRating: true },
    _count: true,
  });
  await prisma.residence.update({
    where: { id: residenceId },
    data: { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count },
  });
}

export async function getMyReview(guestId: number, reservationId: number) {
  await getOwnedReservation(guestId, reservationId, "guest");
  return prisma.review.findUnique({ where: { reservationId } });
}

export async function submitReview(
  guestId: number,
  reservationId: number,
  scores: ReviewScores,
  comment: string
) {
  const reservation = await getOwnedReservation(guestId, reservationId, "guest");

  if (reservation.state !== "DONE") {
    throw AppError.badRequest("فقط برای رزروهای تکمیل‌شده می‌توانید نظر ثبت کنید");
  }

  const existing = await prisma.review.findUnique({ where: { reservationId } });
  if (existing) {
    throw AppError.badRequest("برای این رزرو قبلاً نظر ثبت شده است");
  }

  const values = Object.values(scores);
  const averageRating = values.reduce((a, b) => a + b, 0) / values.length;

  const review = await prisma.review.create({
    data: {
      reservationId,
      residenceId: reservation.residenceId,
      guestId,
      ...scores,
      averageRating,
      comment,
    },
  });

  await recomputeResidenceRating(reservation.residenceId);

  notify.onReviewCreated(review.id);
  return review;
}

// Host-facing review management is keyed by the review's own id (not the
// reservation's) — that's what `front/api/Comment.ts`'s existing UI
// (`components/Comments/*`) already calls `commentId` and was built around.

export async function listHostReviews(hostId: number) {
  return prisma.review.findMany({
    where: { residence: { hostId } },
    orderBy: { createdAt: "desc" },
    include: { guest: { select: { name: true } }, residence: { select: { reference: true } } },
  });
}

export async function getHostReviewDetail(hostId: number, reviewId: number) {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, residence: { hostId } },
    include: {
      guest: { select: { name: true } },
      residence: {
        select: {
          reference: true,
          name: true,
          type: true,
          images: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });
  if (!review) {
    throw AppError.notFound("نظر یافت نشد");
  }
  return review;
}

export async function replyToReview(hostId: number, reviewId: number, hostAnswer: string) {
  const review = await prisma.review.findFirst({ where: { id: reviewId, residence: { hostId } } });
  if (!review) {
    throw AppError.notFound("نظر یافت نشد");
  }
  // A host's reply is not published on submission — it goes into the panel's
  // queue, same as the guest's comment did. Without this the reply appears on
  // the site immediately and the review page's «در انتظار تایید نظر میزبان»
  // state could never happen.
  return prisma.review.update({
    where: { id: reviewId },
    data: { hostAnswer, hostAnswerStatus: "PENDING", hostAnsweredAt: new Date() },
  });
}

/**
 * A guest cancelling their own booking.
 *
 * The whole act — state, penalty, refund, the host's income, the calendar and
 * the messages — lives in `cancellation.service`. This function's job is to
 * prove the booking is theirs and hand over; when it did the work itself, it
 * set a state and released a calendar and touched no money at all, so a guest
 * who cancelled a paid booking simply never got anything back.
 */
export async function guestCancelReservation(guestId: number, id: number, reason?: string) {
  const reservation = await getOwnedReservation(guestId, id, "guest");

  if (reservation.state === "CANCEL" || reservation.state === "DONE") {
    throw AppError.badRequest("این رزرو قابل لغو نیست");
  }

  const { cancelReservation } = await import("./cancellation.service");

  const result = await cancelReservation({
    reservationId: id,
    cancelledBy: "GUEST_CANCELLED",
    reason: reason ?? "لغو توسط مهمان",
    // A guest cannot mark their own cancellation justified or waive their own
    // refund. Both are support's call, and leaving them here would make the
    // penalty ladder a suggestion.
    notifyMode: "BOTH",
    actorId: guestId,
  });

  return prisma.reservation.findUniqueOrThrow({
    where: { id: result.reservation.id },
    include: RESERVATION_INCLUDE,
  });
}

/** What a guest would get back, shown before they confirm. */
export async function guestCancelQuote(guestId: number, id: number) {
  await getOwnedReservation(guestId, id, "guest");
  const { quoteFor } = await import("./cancellation.service");
  return quoteFor(id, { cancelledBy: "GUEST_CANCELLED" });
}
