import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { generateReference } from "@/utils/reference";

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
  data: { type: "BOOMGARDI" | "SUIT"; name: string; cityId?: number }
) {
  return prisma.residence.create({
    data: {
      hostId,
      type: data.type,
      name: data.name,
      cityId: data.cityId,
      reference: generateReference("RES-"),
      state: "DRAFT",
      step: 1,
    },
  });
}

export async function updateSpecs(
  hostId: number,
  id: number,
  data: Prisma.ResidenceUpdateInput
) {
  await assertOwnership(hostId, id);
  return prisma.residence.update({ where: { id }, data });
}

export async function updateAmenities(
  hostId: number,
  id: number,
  amenities: { amenityId: number; extraFeatures?: Record<string, unknown> }[]
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
    rules: { ruleId: number; value?: unknown }[];
    checkinFrom?: string;
    checkinTo?: string;
    checkout?: string;
    minReservableDays?: number;
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
    await tx.residence.update({ where: { id }, data: residenceFields });
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

// ---------- Host: images ----------

export async function addImage(hostId: number, residenceId: number, url: string, title?: string) {
  await assertOwnership(hostId, residenceId);
  const count = await prisma.residenceImage.count({ where: { residenceId } });
  return prisma.residenceImage.create({
    data: { residenceId, url, title, sortOrder: count, isMain: count === 0 },
  });
}

export async function deleteImage(hostId: number, residenceId: number, imageId: number) {
  await assertOwnership(hostId, residenceId);
  await prisma.residenceImage.deleteMany({ where: { id: imageId, residenceId } });
}

export async function reorderImages(hostId: number, residenceId: number, imageIds: number[]) {
  await assertOwnership(hostId, residenceId);
  await prisma.$transaction(
    imageIds.map((id, index) =>
      prisma.residenceImage.update({
        where: { id },
        data: { sortOrder: index, isMain: index === 0 },
      })
    )
  );
}
