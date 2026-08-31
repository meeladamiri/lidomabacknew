import { Prisma, type ResidenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { generateReference } from "@/utils/reference";
import { deleteStoredFile } from "@/middleware/upload";
import { RESIDENCE_CARD_SELECT, toCard } from "@/modules/search/search.service";
import { publicResidenceId, resolvePublicResidenceId } from "@/lib/publicId";
import { getActiveSeoTags } from "@/lib/seoTags";

// ---------- Public ----------

// "جستجوهای مرتبط" on a residence page: the SEO tags whose criteria THIS
// residence actually satisfies, pointed at its own location
// (/search/<slug>?<tag>=1) — same behavior as the legacy Odoo site.
//
// This used to be a hand-maintained list that duplicated (and disagreed with)
// the search service's tag tables. It now evaluates the same stored conditions
// the search filter uses, so a tag edited in the admin panel stays consistent
// on both surfaces.
async function buildRelatedTags(
  amenities: { amenity: { key: string | null }; extraFeatures: unknown }[],
  location: { name: string; titleEn: string | null } | null
) {
  if (!location?.titleEn) return [];

  const valueByKey = new Map<string, string>();
  for (const a of amenities) {
    if (a.amenity.key) valueByKey.set(a.amenity.key, String((a.extraFeatures as any)?.value ?? ""));
  }

  const tags = await getActiveSeoTags();
  const matched = tags.filter((tag) => {
    if (!tag.conditions.length) return false;

    // Same semantics as tagToWhere: OR inside a group, AND across groups.
    const groups = new Map<number, typeof tag.conditions>();
    for (const c of tag.conditions) {
      if (!groups.has(c.groupIndex)) groups.set(c.groupIndex, []);
      groups.get(c.groupIndex)!.push(c);
    }
    return [...groups.values()].every((conds) =>
      conds.some((c) => {
        const key = c.amenityKey ?? c.ruleKey;
        if (!key) return false;
        const v = valueByKey.get(key);
        if (v === undefined) return false;
        return c.valueName ? v.includes(c.valueName) : true;
      })
    );
  });

  return matched
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((t) => ({
      tag: t.key,
      cat_title: location.titleEn,
      cat_name: location.name,
      // e.g. "اجاره ویلا و سوئیت استخردار در شیراز" — same as the tag pages' H1
      title: `${t.name} در ${location.name}`,
    }));
}

export async function getResidenceDetail(rawId: number) {
  // legacy-URL contract: /rentals/<id> uses the Odoo id for migrated
  // residences (see lib/publicId.ts)
  const id = await resolvePublicResidenceId(rawId);
  const residence = await prisma.residence.findFirst({
    where: { id, state: "PUBLISHED", published: true },
    include: {
      location: { include: { parent: true } },
      images: { orderBy: { sortOrder: "asc" } },
      rooms: true,
      amenities: { include: { amenity: { include: { features: true } } } },
      rules: { include: { rule: true } },
      host: { select: { id: true, name: true, avatarUrl: true, createdAt: true } },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { guest: { select: { name: true } } },
      },
    },
  });

  if (!residence) {
    throw AppError.notFound("اقامتگاه یافت نشد");
  }

  const similar = await prisma.residence.findMany({
    where: {
      id: { not: id },
      locationId: residence.locationId ?? undefined,
      state: "PUBLISHED",
      published: true,
    },
    select: {
      id: true,
      reference: true,
      name: true,
      averageRating: true,
      weekPrice: true,
      maxCapacity: true,
      images: { take: 1, orderBy: { sortOrder: "asc" } },
      rooms: { select: { id: true } },
    },
    take: 6,
  });

  const tags = await buildRelatedTags(residence.amenities, residence.location);

  return {
    residence,
    // legacy-URL contract for links + the displayed "کد آگهی"
    publicId: publicResidenceId(residence),
    similar: similar.map((s) => ({ ...s, id: publicResidenceId(s), roomsCount: s.rooms.length })),
    tags,
  };
}

export async function getHostProfile(hostId: number) {
  const host = await prisma.user.findFirst({
    where: { id: hostId, isHost: true },
    select: { id: true, name: true, avatarUrl: true, description: true, createdAt: true },
  });

  if (!host) {
    throw AppError.notFound("میزبان یافت نشد");
  }

  const [residences, totalReservations, confirmedReservations, reviews] = await Promise.all([
    prisma.residence.findMany({
      where: { hostId, state: "PUBLISHED", published: true },
      select: RESIDENCE_CARD_SELECT,
      orderBy: { createdAt: "desc" },
    }),
    prisma.reservation.count({ where: { hostId } }),
    prisma.reservation.count({ where: { hostId, state: { in: ["SECOND_PAYMENT", "DONE"] } } }),
    prisma.review.findMany({
      where: { residence: { hostId } },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        guest: { select: { name: true } },
        residence: { select: { id: true, name: true, type: true, images: { take: 1, orderBy: { sortOrder: "asc" } } } },
      },
    }),
  ]);

  // No response-time tracking exists yet (no host/guest chat) — the only
  // proxy we currently have is how often a host's reservations actually
  // proceed past their approval step. Defaults to 100 for a host with no
  // reservation history yet, rather than implying a bad track record.
  const confirmPercent = totalReservations > 0 ? (confirmedReservations / totalReservations) * 100 : 100;

  // The host's "home" city for SEO copy ("میزبان لیدوما در شیراز") — the
  // most frequent city among their published residences.
  const cityCounts = new Map<string, number>();
  for (const r of residences) {
    const c = r.location?.name;
    if (c) cityCounts.set(c, (cityCounts.get(c) ?? 0) + 1);
  }
  const cityName = [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    host: { ...host, confirmPercent, cityName },
    residences: residences.map(toCard),
    reviews,
  };
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
      location: { include: { parent: true } },
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
  data: { type: ResidenceType; name?: string; cityId?: number }
) {
  return prisma.residence.create({
    data: {
      hostId,
      type: data.type,
      name: data.name || "اقامتگاه بدون نام", // wizard fills the real name in a later step
      locationId: data.cityId,
      reference: generateReference("RES-"),
      state: "DRAFT",
      step: 1,
    },
  });
}

const WIZARD_STEP_COUNT = 14;

/**
 * The wizard progress marker, folded into whatever update is already running.
 *
 * The front used to advance it with a second PATCH after every step that
 * writes a sub-resource — amenities, rules, pricing, capacity, rooms, submit —
 * so seven of the fourteen steps cost two serial round trips on a host's phone
 * before the next screen could appear. Every one of those handlers already
 * updates the residence row; the marker rides along.
 *
 * It only ever moves forward: a host revisiting step 4 of a draft they had
 * taken to step 11 must not be shown as having lost seven steps of work.
 */
function stepPatch(
  current: number | null | undefined,
  step: number | undefined
): { step?: number; completionPercent?: number } {
  if (step === undefined) return {};
  const next = Math.max(current ?? 0, step);
  return { step: next, completionPercent: Math.round((next / WIZARD_STEP_COUNT) * 100) };
}

export async function updateSpecs(
  hostId: number,
  id: number,
  // Unchecked rather than the relation form: this writes locationId as a
  // scalar, which the checked input type does not allow.
  data: Prisma.ResidenceUncheckedUpdateInput & { step?: number; cityId?: number; cityName?: string }
) {
  const residence = await assertOwnership(hostId, id);
  const { step, cityId, cityName, ...fields } = data;

  // The schema calls it cityId; the column is location_id. Passing the body
  // straight through meant Prisma rejected the whole update as an unknown
  // argument, so the wizard's address step failed every time a city was
  // chosen — which is every time it is used.
  let locationId = cityId;

  // An explicit id wins; the name is the wizard's fallback, resolved here
  // rather than by the client so the address step stays one request.
  if (locationId === undefined && cityName) {
    const city = await prisma.location.findFirst({
      where: { name: cityName, type: "CITY" },
      select: { id: true },
    });
    locationId = city?.id;
  }

  return prisma.residence.update({
    where: { id },
    data: {
      ...fields,
      ...(locationId !== undefined ? { locationId } : {}),
      ...stepPatch(residence.step, step),
    },
  });
}

export async function updateAmenities(
  hostId: number,
  id: number,
  amenities: { amenityId: number; extraFeatures?: Record<string, unknown> }[],
  other?: string,
  step?: number
) {
  const residence = await assertOwnership(hostId, id);
  const advance = stepPatch(residence.step, step);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(advance).length > 0) {
      await tx.residence.update({ where: { id }, data: advance });
    }
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
    step?: number;
  }
) {
  const residence = await assertOwnership(hostId, id);
  const { rules, step, ...residenceFields } = data;
  const patch = { ...residenceFields, ...stepPatch(residence.step, step) };
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(patch).length > 0) {
      await tx.residence.update({ where: { id }, data: patch });
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
  data: Prisma.ResidenceUpdateInput & { step?: number }
) {
  const residence = await assertOwnership(hostId, id);
  const { step, ...fields } = data;
  return prisma.residence.update({
    where: { id },
    data: { ...fields, ...stepPatch(residence.step, step) },
  });
}

export async function updateCapacity(
  hostId: number,
  id: number,
  data: { capacity?: number; maxCapacity?: number; step?: number }
) {
  const residence = await assertOwnership(hostId, id);
  const { step, ...fields } = data;
  return prisma.residence.update({
    where: { id },
    data: { ...fields, ...stepPatch(residence.step, step) },
  });
}

export async function changeResidenceState(
  hostId: number,
  id: number,
  action: "activate" | "deactivate" | "delete" | "submit",
  step?: number
) {
  const residence = await assertOwnership(hostId, id);
  const advance = stepPatch(residence.step, step);
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
      ...advance,
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
    step?: number;
  }
) {
  const residence = await assertOwnership(hostId, id);
  const { rooms, step, ...residenceFields } = data;
  const patch = { ...residenceFields, ...stepPatch(residence.step, step) };
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(patch).length > 0) {
      await tx.residence.update({ where: { id }, data: patch });
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

/**
 * Edits one photo: its caption, its alt text, or which one is the main image.
 *
 * Promoting a photo demotes the current main in the same transaction. Two
 * images flagged main is a listing whose cover picture depends on which row
 * the query happens to return first.
 */
export async function updateImage(
  hostId: number,
  residenceId: number,
  imageId: number,
  data: { title?: string | null; alt?: string | null; isMain?: boolean }
) {
  await assertOwnership(hostId, residenceId);

  const image = await prisma.residenceImage.findFirst({
    where: { id: imageId, residenceId },
    select: { id: true },
  });
  if (!image) throw AppError.notFound("تصویر پیدا نشد");

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (data.isMain === true) {
      await tx.residenceImage.updateMany({
        where: { residenceId, isMain: true },
        data: { isMain: false },
      });
    }

    return tx.residenceImage.update({
      where: { id: imageId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.alt !== undefined ? { alt: data.alt } : {}),
        ...(data.isMain !== undefined ? { isMain: data.isMain } : {}),
      },
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
