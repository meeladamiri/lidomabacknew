import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * The host's calendar.
 *
 * A `calendar_days` row is an **exception**, not a record of a day. Every date
 * a listing has is already described by the listing itself — its base rate, its
 * weekend and peak rates, whether it takes instant bookings — and a row here
 * exists only to say "this particular date is different".
 *
 * That was not being enforced, and it showed: of 5,311 rows, 671 carried
 * nothing but an instant-book flag identical to the listing's own default, and
 * 14 carried nothing at all. Marking a season as instant-book wrote a row per
 * night to store a boolean the listing already held.
 *
 * So writes here normalise: a value equal to the listing's default is stored as
 * "no override", and a row left saying nothing is deleted rather than kept.
 * Reads are unaffected — a missing row has always meant "same as the listing".
 */

async function loadOwnedResidence(hostId: number, residenceId: number) {
  const residence = await prisma.residence.findUnique({
    where: { id: residenceId },
    select: { id: true, hostId: true, isFast: true },
  });
  if (!residence || residence.hostId !== hostId) {
    throw AppError.notFound("اقامتگاه یافت نشد یا متعلق به شما نیست");
  }
  return residence;
}

export async function getCalendar(
  residenceId: number,
  roomId: number | undefined,
  from: string,
  to: string
) {
  return prisma.calendarDay.findMany({
    where: {
      residenceId,
      roomId: roomId ?? null,
      date: { gte: new Date(from), lte: new Date(to) },
    },
    orderBy: { date: "asc" },
  });
}

/** True when a row carries no exception at all and is therefore just noise. */
function saysNothing(row: {
  isBlocked: boolean;
  isFast: boolean | null;
  isPeak: boolean;
  specialPrice: number | null;
  discountAmount: number | null;
}) {
  return (
    row.isBlocked === false &&
    row.isFast === null &&
    row.isPeak === false &&
    row.specialPrice === null &&
    row.discountAmount === null
  );
}

export async function updateCalendar(
  hostId: number,
  residenceId: number,
  data: {
    roomId?: number;
    dates: string[];
    isBlocked?: boolean;
    isFast?: boolean;
    specialPrice?: number | null;
    discountAmount?: number | null;
    discountType?: "PERCENTAGE" | "FIXED_PRICE";
    reset?: boolean;
  }
) {
  const residence = await loadOwnedResidence(hostId, residenceId);
  const roomId = data.roomId ?? null;
  const dates = data.dates.map((d) => new Date(d));

  if (data.reset) {
    await prisma.calendarDay.deleteMany({
      where: { residenceId, roomId, date: { in: dates } },
    });
    return { success: true, cleared: dates.length };
  }

  /**
   * An instant-book answer matching the listing's own default is not an
   * exception, so it is stored as `null` — no override. This is what stops a
   * host who switches a season to instant-book from writing a row per night.
   */
  const isFastOverride =
    data.isFast === undefined
      ? undefined
      : data.isFast === residence.isFast
        ? null
        : data.isFast;

  const patch = {
    ...(data.isBlocked !== undefined ? { isBlocked: data.isBlocked } : {}),
    ...(isFastOverride !== undefined ? { isFast: isFastOverride } : {}),
    ...(data.specialPrice !== undefined ? { specialPrice: data.specialPrice } : {}),
    ...(data.discountAmount !== undefined ? { discountAmount: data.discountAmount } : {}),
    ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
  };

  // Nothing to say and nothing to clear.
  if (Object.keys(patch).length === 0) return { success: true, written: 0, removed: 0 };

  let removed = 0;

  await prisma.$transaction(
    async (tx) => {
      // Prisma cannot upsert on a compound unique containing a NULL (roomId is
      // null for whole-residence days), so this is read-then-write — but
      // batched into a handful of statements rather than one pair per date.
      const existing = await tx.calendarDay.findMany({
        where: { residenceId, roomId, date: { in: dates } },
        select: {
          id: true,
          date: true,
          isBlocked: true,
          isFast: true,
          isPeak: true,
          specialPrice: true,
          discountAmount: true,
        },
      });

      const existingDates = new Set(existing.map((row) => row.date.getTime()));
      const newDates = dates.filter((d) => !existingDates.has(d.getTime()));

      // Which existing rows would still carry an exception after this patch,
      // and which would be left saying nothing.
      const after = existing.map((row) => ({ ...row, ...patch }));
      const keepIds = after.filter((row) => !saysNothing(row)).map((row) => row.id);
      const dropIds = after.filter((row) => saysNothing(row)).map((row) => row.id);

      if (keepIds.length > 0) {
        await tx.calendarDay.updateMany({ where: { id: { in: keepIds } }, data: patch });
      }
      if (dropIds.length > 0) {
        // The listing's own settings already describe these dates.
        const result = await tx.calendarDay.deleteMany({ where: { id: { in: dropIds } } });
        removed = result.count;
      }

      if (newDates.length > 0) {
        const candidate = {
          isBlocked: data.isBlocked ?? false,
          isFast: isFastOverride ?? null,
          isPeak: false,
          specialPrice: data.specialPrice ?? null,
          discountAmount: data.discountAmount ?? null,
        };
        // A brand-new row that would say nothing is simply not created.
        if (!saysNothing(candidate)) {
          await tx.calendarDay.createMany({
            data: newDates.map((date) => ({
              residenceId,
              roomId,
              date,
              ...candidate,
              discountType: data.discountType,
            })),
          });
        }
      }
    },
    { timeout: 15000 }
  );

  return { success: true, removed };
}

/**
 * Deletes exception rows that no longer say anything.
 *
 * Used by the maintenance script; the write path above keeps new rows honest,
 * but rows written before it did are still out there.
 */
export async function pruneEmptyDays(residenceId?: number) {
  return prisma.calendarDay.deleteMany({
    where: {
      ...(residenceId ? { residenceId } : {}),
      isBlocked: false,
      isFast: null,
      isPeak: false,
      specialPrice: null,
      discountAmount: null,
    },
  });
}
