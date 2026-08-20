import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { generateReference } from "@/utils/reference";
import { calculateStayPrice } from "./pricing";

const RESERVATION_INCLUDE = {
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
      city: {
        select: {
          name: true,
          titleEn: true,
          province: { select: { name: true } },
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
      id: data.residenceId,
      state: "PUBLISHED",
      published: true,
    },
    select: {
      id: true,
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
          reference: generateReference("RSV-"),
          residenceId: residence.id,
          guestId,
          hostId: residence.hostId,
          startDate,
          endDate,
          daysCount: pricing.nights,
          guestsCount: data.guestsCount,
          extraGuestsCount: data.extraGuestsCount ?? 0,
          totalAmount: pricing.totalAmount,
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
      for (const day of days) {
        const existing = await tx.calendarDay.findFirst({
          where: { residenceId: day.residenceId, roomId: day.roomId, date: day.date },
          select: { id: true },
        });

        if (existing) {
          await tx.calendarDay.update({ where: { id: existing.id }, data: { isBlocked: true } });
        } else {
          await tx.calendarDay.create({
            data: {
              residenceId: day.residenceId,
              roomId: day.roomId,
              date: day.date,
              isBlocked: day.isBlocked,
            },
          });
        }
      }

      return created;
    }
  );

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

async function releaseCalendarDays(
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

  return prisma.reservation.update({
    where: {
      id,
    },
    data: {
      state: "SECOND_PAYMENT",
    },
    include: RESERVATION_INCLUDE,
  });
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

  return updated;
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

  return updated;
}

export async function guestCancelReservation(
  guestId: number,
  id: number,
  reason?: string
) {
  const reservation = await getOwnedReservation(guestId, id, "guest");

  if (reservation.state === "CANCEL" || reservation.state === "DONE") {
    throw AppError.badRequest("این رزرو قابل لغو نیست");
  }

  const updated = await prisma.reservation.update({
    where: {
      id,
    },
    data: {
      state: "CANCEL",
      cancelledBy: "GUEST_CANCELLED",
      cancelReason: reason,
    },
    include: RESERVATION_INCLUDE,
  });

  await releaseCalendarDays(
    reservation.residenceId,
    reservation.startDate,
    reservation.endDate
  );

  return updated;
}
