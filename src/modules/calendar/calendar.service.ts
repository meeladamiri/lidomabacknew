import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

async function assertOwnership(hostId: number, residenceId: number) {
  const residence = await prisma.residence.findUnique({ where: { id: residenceId } });
  if (!residence || residence.hostId !== hostId) {
    throw AppError.notFound("اقامتگاه یافت نشد یا متعلق به شما نیست");
  }
}

export async function getCalendar(residenceId: number, roomId: number | undefined, from: string, to: string) {
  return prisma.calendarDay.findMany({
    where: {
      residenceId,
      roomId: roomId ?? null,
      date: { gte: new Date(from), lte: new Date(to) },
    },
    orderBy: { date: "asc" },
  });
}

export async function updateCalendar(
  hostId: number,
  residenceId: number,
  data: {
    roomId?: number;
    dates: string[];
    isBlocked?: boolean;
    isFast?: boolean;
    specialPrice?: number;
    discountAmount?: number;
    discountType?: "PERCENTAGE" | "FIXED_PRICE";
    reset?: boolean;
  }
) {
  await assertOwnership(hostId, residenceId);

  const roomId = data.roomId ?? null;

  if (data.reset) {
    await prisma.calendarDay.deleteMany({
      where: { residenceId, roomId, date: { in: data.dates.map((d) => new Date(d)) } },
    });
    return { success: true };
  }

  // Can't use upsert's compound-unique `where` here — Prisma/Postgres unique lookups
  // don't match on NULL, and `roomId` is null for whole-residence (non-room-specific) days.
  await prisma.$transaction(async (tx) => {
    for (const dateStr of data.dates) {
      const date = new Date(dateStr);
      const existing = await tx.calendarDay.findFirst({
        where: { residenceId, roomId, date },
        select: { id: true },
      });

      if (existing) {
        await tx.calendarDay.update({
          where: { id: existing.id },
          data: {
            ...(data.isBlocked !== undefined ? { isBlocked: data.isBlocked } : {}),
            ...(data.isFast !== undefined ? { isFast: data.isFast } : {}),
            ...(data.specialPrice !== undefined ? { specialPrice: data.specialPrice } : {}),
            ...(data.discountAmount !== undefined ? { discountAmount: data.discountAmount } : {}),
            ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
          },
        });
      } else {
        await tx.calendarDay.create({
          data: {
            residenceId,
            roomId,
            date,
            isBlocked: data.isBlocked ?? false,
            isFast: data.isFast,
            specialPrice: data.specialPrice,
            discountAmount: data.discountAmount,
            discountType: data.discountType,
          },
        });
      }
    }
  });

  return { success: true };
}
