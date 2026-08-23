import {
  Prisma,
  ResidenceState,
  ReservationState,
} from "../../generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { parsePagination } from "@/utils/pagination";
import { RESERVATION_INCLUDE, releaseCalendarDays } from "@/modules/reservations/reservations.service";
import * as residencesService from "@/modules/residences/residences.service";

export async function getDashboardStats() {
  const [
    usersCount,
    hostsCount,
    residencesByState,
    reservationsByState,
    revenueAgg,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isHost: true } }),
    prisma.residence.groupBy({ by: ["state"], _count: true }),
    prisma.reservation.groupBy({ by: ["state"], _count: true }),
    prisma.reservation.aggregate({
      where: { state: "DONE" },
      _sum: { totalAmount: true },
    }),
  ]);

  return {
    usersCount,
    hostsCount,
// بخش داخل getDashboardStats
residencesByState: Object.fromEntries(
  residencesByState.map((r: { state: string; _count: number }) => [r.state, r._count])
),
reservationsByState: Object.fromEntries(
  reservationsByState.map((r: { state: string; _count: number }) => [r.state, r._count])
),
    totalRevenue: revenueAgg._sum.totalAmount ?? 0,
  };
}

// Every User scalar field except passwordHash — never let it leave this module.
const USER_SELECT_BASE = {
  id: true,
  phone: true,
  name: true,
  email: true,
  nationalCode: true,
  address: true,
  cityId: true,
  zip: true,
  fax: true,
  job: true,
  education: true,
  birthDay: true,
  birthMonth: true,
  birthYear: true,
  emergencyPhone: true,
  contactPhone: true,
  avatarUrl: true,
  nationalCardUrl: true,
  description: true,
  verificationStatus: true,
  isHost: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listUsers(params: { page?: number; pageSize?: number; q?: string }) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.UserWhereInput = params.q
    ? {
        OR: [
          { phone: { contains: params.q } },
          { name: { contains: params.q, mode: "insensitive" } },
          { email: { contains: params.q, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: USER_SELECT_BASE,
    }),
  ]);

  return { total, page, pageSize, items };
}

export async function getUser(id: number) {
  return prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      ...USER_SELECT_BASE,
      city: { include: { province: true } },
      bankAccount: true,
      residences: { select: { id: true, name: true, state: true } },
      _count: { select: { reservationsAsGuest: true, reservationsAsHost: true } },
    },
  });
}

export async function updateUser(
  id: number,
  data: { isHost?: boolean; role?: "USER" | "ADMIN"; verificationStatus?: "NOT_CONFIRMED" | "CHECKING" | "CONFIRMED" }
) {
  return prisma.user.update({ where: { id }, data });
}

// ---------- Residence custom filters ----------
// Whitelist of fields the admin filter builder is allowed to query, keyed to
// their Prisma type — deliberately excludes images/binary/internal fields.
// `cityName` is special-cased (it filters through the `city` relation, not a
// scalar column on Residence).
type FilterFieldType = "string" | "number" | "boolean" | "enum" | "date";

export const RESIDENCE_FILTER_FIELDS: Record<
  string,
  { label: string; type: FilterFieldType; enumValues?: string[] }
> = {
  name: { label: "نام", type: "string" },
  reference: { label: "کد", type: "string" },
  type: { label: "نوع", type: "enum", enumValues: ["BOOMGARDI", "SUIT"] },
  state: {
    label: "وضعیت",
    type: "enum",
    enumValues: ["DRAFT", "PENDING", "PUBLISHED", "REJECTED", "DEACTIVATED", "DELETED"],
  },
  published: { label: "منتشر شده", type: "boolean" },
  cityName: { label: "شهر", type: "string" },
  neighborhood: { label: "محله", type: "string" },
  floor: { label: "طبقه", type: "string" },
  capacity: { label: "ظرفیت", type: "number" },
  maxCapacity: { label: "حداکثر ظرفیت", type: "number" },
  weekPrice: { label: "قیمت هفته", type: "number" },
  weekendPrice: { label: "قیمت آخر هفته", type: "number" },
  peakPrice: { label: "قیمت اوج", type: "number" },
  averageRating: { label: "امتیاز", type: "number" },
  reviewsCount: { label: "تعداد نظرات", type: "number" },
  importance: { label: "اهمیت اقامتگاه", type: "number" },
  salesCount: { label: "تعداد فروش", type: "number" },
  isFast: { label: "رزرو آنی", type: "boolean" },
  isFull: { label: "تکمیل ظرفیت", type: "boolean" },
  isOffer: { label: "پیشنهاد ویژه", type: "boolean" },
  minReservableDays: { label: "حداقل شب اقامت", type: "number" },
  createdAt: { label: "تاریخ ثبت", type: "date" },
};

const OPERATORS_BY_TYPE: Record<FilterFieldType, string[]> = {
  string: ["contains", "equals"],
  number: ["equals", "gte", "lte"],
  boolean: ["equals"],
  enum: ["equals"],
  date: ["gte", "lte"],
};

export interface FilterCondition {
  field: string;
  operator: string;
  value: unknown;
}

function buildResidenceFilterWhere(filters: FilterCondition[]): Prisma.ResidenceWhereInput {
  const where: Prisma.ResidenceWhereInput = {};

  for (const f of filters) {
    const meta = RESIDENCE_FILTER_FIELDS[f.field];
    if (!meta || !OPERATORS_BY_TYPE[meta.type].includes(f.operator)) continue; // ignore anything outside the whitelist

    if (f.field === "cityName") {
      where.city = { name: { contains: String(f.value), mode: "insensitive" } };
      continue;
    }

    let value: unknown = f.value;
    if (meta.type === "number") value = Number(value);
    else if (meta.type === "date") value = new Date(value as string);
    else if (meta.type === "boolean") value = value === true || value === "true";
    else if (meta.type === "enum" && meta.enumValues && !meta.enumValues.includes(String(value))) continue;

    const condition =
      meta.type === "string" && f.operator === "contains"
        ? { contains: value as string, mode: "insensitive" as const }
        : { [f.operator]: value };

    (where as Record<string, unknown>)[f.field] = {
      ...((where as Record<string, unknown>)[f.field] as object | undefined),
      ...condition,
    };
  }

  return where;
}

export async function listResidences(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  state?: string;
  filters?: FilterCondition[];
}) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.ResidenceWhereInput = {
    ...(params.state ? { state: params.state as ResidenceState } : {}),
    ...(params.q ? { name: { contains: params.q, mode: "insensitive" } } : {}),
    ...(params.filters?.length ? buildResidenceFilterWhere(params.filters) : {}),
  };

  const [total, items] = await Promise.all([
    prisma.residence.count({ where }),
    prisma.residence.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        host: { select: { id: true, name: true, phone: true } },
        city: true,
        images: { take: 1, orderBy: { sortOrder: "asc" } },
      },
    }),
  ]);

  return { total, page, pageSize, items };
}

export async function getResidence(id: number) {
  return prisma.residence.findUniqueOrThrow({
    where: { id },
    include: {
      host: { select: { id: true, name: true, phone: true } },
      city: { include: { province: true } },
      images: { orderBy: { sortOrder: "asc" } },
      rooms: true,
      amenities: { include: { amenity: true } },
      rules: { include: { rule: true } },
    },
  });
}

export async function setResidenceState(id: number, state: ResidenceState) {
  return prisma.residence.update({
    where: { id },
    data: { state, published: state === "PUBLISHED" },
  });
}

// ---------- Residence editing (admin) ----------
// Every host-side residences.service.ts function is keyed by (hostId, ...)
// and enforces the caller owns the residence. An admin should be able to
// edit ANY residence, so these thin wrappers just resolve the residence's
// (or room's) *real* hostId first and hand off to the exact same,
// already-validated host logic — no business rules duplicated here.

async function resolveHostIdForResidence(id: number): Promise<number> {
  const residence = await prisma.residence.findUniqueOrThrow({ where: { id }, select: { hostId: true } });
  return residence.hostId;
}

async function resolveHostIdForRoom(roomId: number): Promise<number> {
  const room = await prisma.room.findUniqueOrThrow({
    where: { id: roomId },
    select: { residence: { select: { hostId: true } } },
  });
  return room.residence.hostId;
}

export async function adminUpdateResidenceSpecs(
  id: number,
  data: Parameters<typeof residencesService.updateSpecs>[2]
) {
  return residencesService.updateSpecs(await resolveHostIdForResidence(id), id, data);
}

export async function adminUpdateAmenities(
  id: number,
  amenities: Parameters<typeof residencesService.updateAmenities>[2],
  other?: string
) {
  return residencesService.updateAmenities(await resolveHostIdForResidence(id), id, amenities, other);
}

export async function adminUpdateRules(id: number, data: Parameters<typeof residencesService.updateRules>[2]) {
  return residencesService.updateRules(await resolveHostIdForResidence(id), id, data);
}

export async function adminUpdatePricing(
  id: number,
  data: Parameters<typeof residencesService.updatePricing>[2]
) {
  return residencesService.updatePricing(await resolveHostIdForResidence(id), id, data);
}

export async function adminUpdateCapacity(
  id: number,
  data: Parameters<typeof residencesService.updateCapacity>[2]
) {
  return residencesService.updateCapacity(await resolveHostIdForResidence(id), id, data);
}

export async function adminAddRoom(id: number, data: Parameters<typeof residencesService.addRoom>[2]) {
  return residencesService.addRoom(await resolveHostIdForResidence(id), id, data);
}

export async function adminReplaceRooms(
  id: number,
  data: Parameters<typeof residencesService.replaceRooms>[2]
) {
  return residencesService.replaceRooms(await resolveHostIdForResidence(id), id, data);
}

export async function adminUpdateRoom(
  roomId: number,
  data: Parameters<typeof residencesService.updateRoom>[2]
) {
  return residencesService.updateRoom(await resolveHostIdForRoom(roomId), roomId, data);
}

export async function adminDeleteRoom(roomId: number) {
  return residencesService.deleteRoom(await resolveHostIdForRoom(roomId), roomId);
}

export async function adminAddImage(id: number, url: string, title?: string, isMain?: boolean) {
  return residencesService.addImage(await resolveHostIdForResidence(id), id, url, title, isMain);
}

export async function adminDeleteImage(id: number, imageId: number) {
  return residencesService.deleteImage(await resolveHostIdForResidence(id), id, imageId);
}

export async function adminReorderImages(id: number, imageIds: number[]) {
  return residencesService.reorderImages(await resolveHostIdForResidence(id), id, imageIds);
}

export async function listReservations(params: { page?: number; pageSize?: number; state?: string }) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.ReservationWhereInput = params.state
    ? { state: params.state as ReservationState }
    : {};

  const [total, items] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        residence: { select: { id: true, name: true } },
        guest: { select: { id: true, name: true, phone: true } },
        host: { select: { id: true, name: true, phone: true } },
      },
    }),
  ]);

  return { total, page, pageSize, items };
}

export async function getReservation(id: number) {
  return prisma.reservation.findUniqueOrThrow({
    where: { id },
    include: RESERVATION_INCLUDE,
  });
}

type AdminReservationAction = "cancel" | "forceApprove" | "markDone";

// Admin-initiated state changes bypass the host/guest ownership checks the
// regular accept/reject/cancel endpoints enforce — an admin can act on any
// reservation. Kept intentionally narrow (3 actions) to match what this
// backend can actually follow through on: there's no payment gateway yet
// (item 11 in the project's own TODO list), so every reservation today is
// paid for manually — "markDone" is the admin's way of recording that a
// manual payment came in, and "forceApprove" covers a host who never
// responds. Anything Odoo's old sale-order screen offered beyond this
// (invoicing, vouchers, surveys) has no backing feature here yet.
export async function updateReservationByAdmin(
  id: number,
  action: AdminReservationAction,
  reason?: string,
  desc?: string
) {
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id } });

  if (action === "cancel") {
    if (reservation.state === "CANCEL" || reservation.state === "DONE") {
      throw AppError.badRequest("این رزرو قابل لغو نیست");
    }
    const updated = await prisma.reservation.update({
      where: { id },
      data: { state: "CANCEL", cancelledBy: "LIDOMA_CANCELLED", cancelReason: reason, cancelDesc: desc },
      include: RESERVATION_INCLUDE,
    });
    await releaseCalendarDays(reservation.residenceId, reservation.startDate, reservation.endDate);
    return updated;
  }

  if (action === "forceApprove") {
    if (reservation.state !== "HOST_APPROVAL") {
      throw AppError.badRequest("این رزرو در وضعیت قابل تایید نیست");
    }
    return prisma.reservation.update({
      where: { id },
      data: { state: "SECOND_PAYMENT" },
      include: RESERVATION_INCLUDE,
    });
  }

  // markDone
  if (reservation.state !== "SECOND_PAYMENT") {
    throw AppError.badRequest("این رزرو در وضعیت قابل تکمیل نیست");
  }
  return prisma.reservation.update({
    where: { id },
    data: { state: "DONE", paidAmount: reservation.totalAmount, remainingAmount: 0 },
    include: RESERVATION_INCLUDE,
  });
}

// ---------- Filter presets ----------

export async function listFilterPresets(entity?: string) {
  return prisma.adminFilterPreset.findMany({
    where: entity ? { entity } : {},
    orderBy: { createdAt: "desc" },
  });
}

export async function createFilterPreset(name: string, entity: string, filters: FilterCondition[]) {
  return prisma.adminFilterPreset.create({
    data: { name, entity, filters: filters as unknown as Prisma.InputJsonValue },
  });
}

export async function deleteFilterPreset(id: number) {
  await prisma.adminFilterPreset.delete({ where: { id } });
}

// ---------- Catalogs ----------

// `features` (sub-feature definitions — the "توضیحات بیشتر" form fields shown
// per facility) are replaced wholesale when the payload includes them.
type AmenityPayload = {
  key?: string;
  category?: string;
  name: string;
  iconUrl?: string;
  features?: {
    fieldType: "TEXT" | "DROPDOWN" | "SWITCH" | "CHECKBOX";
    name: string;
    placeholder?: string | null;
    values?: string | null;
    inFilter?: boolean;
  }[];
};

export const amenities = {
  list: () => prisma.amenity.findMany({ include: { features: true } }),
  create: ({ features, ...data }: AmenityPayload) =>
    prisma.amenity.create({
      data: { ...data, ...(features ? { features: { create: features } } : {}) },
      include: { features: true },
    }),
  update: async (id: number, { features, ...data }: AmenityPayload) => {
    if (features) {
      await prisma.amenityFeature.deleteMany({ where: { amenityId: id } });
    }
    return prisma.amenity.update({
      where: { id },
      data: { ...data, ...(features ? { features: { create: features } } : {}) },
      include: { features: true },
    });
  },
  remove: (id: number) => prisma.amenity.delete({ where: { id } }),
};

export const rules = {
  list: () => prisma.rule.findMany(),
  create: (data: Prisma.RuleCreateInput) => prisma.rule.create({ data }),
  update: (id: number, data: Prisma.RuleUpdateInput) => prisma.rule.update({ where: { id }, data }),
  remove: (id: number) => prisma.rule.delete({ where: { id } }),
};

export const cities = {
  list: () => prisma.city.findMany({ include: { province: true } }),
  create: (data: Prisma.CityCreateInput) => prisma.city.create({ data }),
  update: (id: number, data: Prisma.CityUpdateInput) => prisma.city.update({ where: { id }, data }),
  remove: (id: number) => prisma.city.delete({ where: { id } }),
};

export const provinces = {
  list: () => prisma.province.findMany(),
  create: (data: Prisma.ProvinceCreateInput) => prisma.province.create({ data }),
  update: (id: number, data: Prisma.ProvinceUpdateInput) => prisma.province.update({ where: { id }, data }),
  remove: (id: number) => prisma.province.delete({ where: { id } }),
};
