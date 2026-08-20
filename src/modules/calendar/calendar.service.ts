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
  // Batched into 3 queries total (instead of one findFirst+create/update per date) so
  // this doesn't blow the transaction timeout against a remote DB.
  const dates = data.dates.map((d) => new Date(d));

  await prisma.$transaction(
    async (tx) => {
      const existingDays = await tx.calendarDay.findMany({
        where: { residenceId, roomId, date: { in: dates } },
        select: { id: true, date: true },
      });
      const existingIds = existingDays.map((d) => d.id);
      const existingDates = new Set(existingDays.map((d) => d.date.getTime()));
      const newDates = dates.filter((d) => !existingDates.has(d.getTime()));

      const updateData = {
        ...(data.isBlocked !== undefined ? { isBlocked: data.isBlocked } : {}),
        ...(data.isFast !== undefined ? { isFast: data.isFast } : {}),
        ...(data.specialPrice !== undefined ? { specialPrice: data.specialPrice } : {}),
        ...(data.discountAmount !== undefined ? { discountAmount: data.discountAmount } : {}),
        ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
      };

      if (existingIds.length > 0) {
        await tx.calendarDay.updateMany({
          where: { id: { in: existingIds } },
          data: updateData,
        });
      }
      if (newDates.length > 0) {
        await tx.calendarDay.createMany({
          data: newDates.map((date) => ({
            residenceId,
            roomId,
            date,
            isBlocked: data.isBlocked ?? false,
            isFast: data.isFast,
            specialPrice: data.specialPrice,
            discountAmount: data.discountAmount,
            discountType: data.discountType,
          })),
        });
      }
    },
    { timeout: 15000 }
  );

  return { success: true };
}
