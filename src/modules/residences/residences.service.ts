import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { generateReference } from "@/utils/reference";
import { deleteStoredFile } from "@/middleware/upload";

// ---------- Public ----------

export async function getResidenceDetail(id: number) {
  const residence = await prisma.residence.findFirst({
    where: { id, state: "PUBLISHED", published: true },
    include: {
      city: { include: { province: true } },
      images: { orderBy: { sortOrder: "asc" } },
      rooms: true,
      amenities: { include: { amenity: { include: { features: true } } } },
      rules: { include: { rule: true } },
      host: { select: { id: true, name: true, avatarUrl: true, createdAt: true } },
    },
  });

  if (!residence) {
    throw AppError.notFound("اقامتگاه یافت نشد");
  }

  const similar = await prisma.residence.findMany({
    where: {
      id: { not: id },
      cityId: residence.cityId ?? undefined,
      state: "PUBLISHED",
      published: true,
    },
    select: {
      id: true,
      name: true,
      averageRating: true,
      weekPrice: true,
      maxCapacity: true,
      images: { take: 1, orderBy: { sortOrder: "asc" } },
    },
    take: 6,
  });

  return { residence, similar };
}

export async function getAmenityCatalog() {
  return prisma.amenity.findMany({ include: { features: true } });
}

export async function getRuleCatalog() {
  return prisma.rule.findMany();
}

// ---------- Host: listing management ----------

export async function listHostResidences(hostId: number) {
  return prisma.residence.findMany({
    where: { hostId },
    include: {
      images: { take: 1, orderBy: { sortOrder: "asc" } },
      rooms: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Reservation-derived stats only — there's no reviews table yet (Phase 2),
// so the rating fields the frontend also expects (location_rate, etc.) are
// left for the API layer to zero out.
export async function getHostResidenceStats(hostId: number, residenceId?: number) {
  const where: Prisma.ReservationWhereInput = {
    hostId,
    ...(residenceId ? { residenceId } : {}),
  };

  const [totalReserves, confirmedReserves, rejectedReserves, doneReservations] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.count({ where: { ...where, state: { in: ["SECOND_PAYMENT", "DONE"] } } }),
    prisma.reservation.count({ where: { ...where, state: "CANCEL" } }),
    prisma.reservation.findMany({
      where: { ...where, state: "DONE" },
      select: { daysCount: true, hostShare: true, totalAmount: true, startDate: true },
    }),
  ]);

  const totalDays = doneReservations.reduce((sum, r) => sum + r.daysCount, 0);
  const totalIncome = doneReservations.reduce((sum, r) => sum + (r.hostShare ?? r.totalAmount), 0);
  const activeMonths = new Set(
    doneReservations.map((r) => `${r.startDate.getFullYear()}-${r.startDate.getMonth()}`)
  ).size;

  return {
    total_reserves: totalReserves,
    confirmed_reserves: confirmedReserves,
    rejected_reserves: rejectedReserves,
    succeed_reserves: doneReservations.length,
    total_days: totalDays,
    total_income: totalIncome,
    average_income: activeMonths > 0 ? Math.round(totalIncome / activeMonths) : 0,
  };
}

export async function getHostResidenceFull(hostId: number, id: number) {
  const residence = await prisma.residence.findFirst({
    where: { id, hostId },
    include: {
      city: { include: { province: true } },
      images: { orderBy: { sortOrder: "asc" } },
      rooms: true,
      amenities: { include: { amenity: true } },
      rules: { include: { rule: true } },
    },
  });
  if (!residence) throw AppError.notFound("اقامتگاه یافت نشد یا متعلق به شما نیست");
  return residence;
}

async function assertOwnership(hostId: number, residenceId: number) {
  const residence = await prisma.residence.findUnique({ where: { id: residenceId } });
  if (!residence || residence.hostId !== hostId) {
    throw AppError.notFound("اقامتگاه یافت نشد یا متعلق به شما نیست");
  }
  return residence;
}

export async function createResidence(
  hostId: number,
  data: { type: "BOOMGARDI" | "SUIT"; name?: string; cityId?: number }
) {
  return prisma.residence.create({
    data: {
      hostId,
      type: data.type,
      name: data.name || "اقامتگاه بدون نام", // wizard fills the real name in a later step
      cityId: data.cityId,
      reference: generateReference("RES-"),
      state: "DRAFT",
      step: 1,
    },
  });
}

const WIZARD_STEP_COUNT = 14;

export async function updateSpecs(
  hostId: number,
  id: number,
  data: Prisma.ResidenceUpdateInput & { step?: number }
) {
  const residence = await assertOwnership(hostId, id);
  const { step, ...fields } = data;
  const patch: Prisma.ResidenceUpdateInput = { ...fields };
  if (step !== undefined) {
    const nextStep = Math.max(residence.step ?? 0, step);
    patch.step = nextStep;
    patch.completionPercent = Math.round((nextStep / WIZARD_STEP_COUNT) * 100);
  }
  return prisma.residence.update({ where: { id }, data: patch });
}

export async function updateAmenities(
  hostId: number,
  id: number,
  amenities: { amenityId: number; extraFeatures?: Record<string, unknown> }[],
  other?: string
) {
  await assertOwnership(hostId, id);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.residenceAmenity.deleteMany({ where: { residenceId: id } });
    if (amenities.length > 0) {
      await tx.residenceAmenity.createMany({
        data: amenities.map((a) => ({
          residenceId: id,
          amenityId: a.amenityId,
          extraFeatures: a.extraFeatures as Prisma.InputJsonValue,
        })),
      });
    }
    if (other !== undefined) {
      await tx.residence.update({ where: { id }, data: { otherAmenities: other } });
    }
    return tx.residence.findUniqueOrThrow({
      where: { id },
      include: { amenities: { include: { amenity: true } } },
    });
  });
}

export async function updateRules(
  hostId: number,
  id: number,
  data: {
    rules?: { ruleId: number; value?: unknown }[];
    checkinFrom?: string;
    checkinTo?: string;
    checkout?: string;
    minReservableDays?: number;
    cancellationPolicy?: string;
    cancellationPolicyDesc?: string;
    fullReturnTime?: number;
    beforeStartTime?: number;
    hostShareTotalAmount?: number;
    hostSharePastNights?: number;
    hostShareFutureNights?: number;
  }
) {
  await assertOwnership(hostId, id);
  const { rules, ...residenceFields } = data;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(residenceFields).length > 0) {
      await tx.residence.update({ where: { id }, data: residenceFields });
    }
    if (rules !== undefined) {
      await tx.residenceRule.deleteMany({ where: { residenceId: id } });
      if (rules.length > 0) {
        await tx.residenceRule.createMany({
          data: rules.map((r) => ({
            residenceId: id,
            ruleId: r.ruleId,
            value: r.value as Prisma.InputJsonValue,
          })),
        });
      }
    }
    return tx.residence.findUniqueOrThrow({
      where: { id },
      include: { rules: { include: { rule: true } } },
    });
  });
}

export async function updatePricing(
  hostId: number,
  id: number,
  data: Prisma.ResidenceUpdateInput
) {
  await assertOwnership(hostId, id);
  return prisma.residence.update({ where: { id }, data });
}

export async function updateCapacity(
  hostId: number,
  id: number,
  data: { capacity?: number; maxCapacity?: number }
) {
  await assertOwnership(hostId, id);
  return prisma.residence.update({ where: { id }, data });
}

export async function changeResidenceState(
  hostId: number,
  id: number,
  action: "activate" | "deactivate" | "delete" | "submit"
) {
  await assertOwnership(hostId, id);
  const stateMap = {
    activate: "PUBLISHED",
    deactivate: "DEACTIVATED",
    delete: "DELETED",
    submit: "PENDING",
  } as const;
  return prisma.residence.update({
    where: { id },
    data: {
      state: stateMap[action],
      published: action === "activate",
    },
  });
}

// ---------- Host: rooms ----------

export async function addRoom(
  hostId: number,
  residenceId: number,
  data: Prisma.RoomCreateWithoutResidenceInput
) {
  await assertOwnership(hostId, residenceId);
  const createData: Prisma.RoomUncheckedCreateInput = {
    ...data,
    residenceId,
  };
  return prisma.room.create({ data: createData });
}

export async function updateRoom(hostId: number, roomId: number, data: Prisma.RoomUpdateInput) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { residence: true } });
  if (!room || room.residence.hostId !== hostId) {
    throw AppError.notFound("اتاق یافت نشد یا متعلق به شما نیست");
  }
  return prisma.room.update({ where: { id: roomId }, data });
}

export async function deleteRoom(hostId: number, roomId: number) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { residence: true } });
  if (!room || room.residence.hostId !== hostId) {
    throw AppError.notFound("اتاق یافت نشد یا متعلق به شما نیست");
  }
  await prisma.room.delete({ where: { id: roomId } });
}

// Wizard step 5 always resends the full room list — replace-all instead of
// diffing against existing rows by id (same pattern as amenities/rules).
export async function replaceRooms(
  hostId: number,
  id: number,
  data: {
    capacity?: number;
    maxCapacity?: number;
    rooms: Prisma.RoomCreateWithoutResidenceInput[];
  }
) {
  await assertOwnership(hostId, id);
  const { rooms, ...residenceFields } = data;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(residenceFields).length > 0) {
      await tx.residence.update({ where: { id }, data: residenceFields });
    }
    await tx.room.deleteMany({ where: { residenceId: id } });
    if (rooms.length > 0) {
      await tx.room.createMany({
        data: rooms.map((r) => ({ ...r, residenceId: id })) as Prisma.RoomUncheckedCreateInput[],
      });
    }
    return tx.residence.findUniqueOrThrow({ where: { id }, include: { rooms: true } });
  });
}

// ---------- Host: documents (KYC / ownership proof) ----------

export async function updateDocuments(
  hostId: number,
  id: number,
  data: { hostNationalCardUrl?: string; documentUrl?: string; ownerNationalCardUrl?: string }
) {
  await assertOwnership(hostId, id);
  return prisma.residence.update({ where: { id }, data });
}

// ---------- Host: images ----------

export async function addImage(
  hostId: number,
  residenceId: number,
  url: string,
  title?: string,
  isMain?: boolean
) {
  await assertOwnership(hostId, residenceId);
  const count = await prisma.residenceImage.count({ where: { residenceId } });
  // Uploads can race (main + gallery images upload concurrently), so an
  // explicit `isMain` always wins over the "first image wins" fallback.
  const shouldBeMain = isMain !== undefined ? isMain : count === 0;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (shouldBeMain) {
      await tx.residenceImage.updateMany({ where: { residenceId, isMain: true }, data: { isMain: false } });
    }
    return tx.residenceImage.create({
      data: { residenceId, url, title, sortOrder: count, isMain: shouldBeMain },
    });
  });
}

export async function deleteImage(hostId: number, residenceId: number, imageId: number) {
  await assertOwnership(hostId, residenceId);
  const image = await prisma.residenceImage.findFirst({ where: { id: imageId, residenceId } });
  await prisma.residenceImage.deleteMany({ where: { id: imageId, residenceId } });
  await deleteStoredFile(image?.url);
}

// Only reorders — does NOT touch `isMain`. The wizard's image_ids list
// excludes the main image entirely (it's set explicitly at upload time), so
// forcing index 0 to be main here would both mis-flag a gallery photo and
// leave two images marked main at once.
export async function reorderImages(hostId: number, residenceId: number, imageIds: number[]) {
  await assertOwnership(hostId, residenceId);
  const toDelete = await prisma.residenceImage.findMany({
    where: { residenceId, isMain: false, id: { notIn: imageIds } },
    select: { url: true },
  });
  await prisma.residenceImage.deleteMany({
    where: { residenceId, isMain: false, id: { notIn: imageIds } },
  });
  await Promise.all(toDelete.map((img) => deleteStoredFile(img.url)));
  await prisma.$transaction(
    imageIds.map((id, index) =>
      prisma.residenceImage.update({
        where: { id },
        data: { sortOrder: index },
      })
    )
  );
}
