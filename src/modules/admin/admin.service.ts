import {
  Prisma,
  ResidenceState,
  ReservationState,
  type LocationType,
  type ResidenceType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { parsePagination } from "@/utils/pagination";
import bcrypt from "bcryptjs";
import { publicResidenceId } from "@/lib/publicId";
import { RESIDENCE_TYPES, RESIDENCE_TYPE_LABEL } from "@/lib/residenceType";
import { generateReference } from "@/utils/reference";
import { RESERVATION_INCLUDE, releaseCalendarDays } from "@/modules/reservations/reservations.service";
import * as residencesService from "@/modules/residences/residences.service";
import * as notify from "@/modules/notifications/events";
import * as walletService from "@/modules/wallet/wallet.service";
import * as reservationSettings from "@/modules/settings/reservationSettings.service";
import { hostRulesText, hostRuleNotes } from "@/modules/residences/hostRules";

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

// Richer dashboard payload: headline tiles, a 12-month trend series for the
// chart, and the latest activity lists.
export async function getDashboardOverview() {
  const now = new Date();
  const monthsBack = 11;
  const since = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    base,
    newUsersThisMonth,
    newUsersPrevMonth,
    reservationsThisMonth,
    reservationsPrevMonth,
    revenueThisMonth,
    pendingResidences,
    pendingReservations,
    trendRows,
    recentUsers,
    recentReservations,
  ] = await Promise.all([
    getDashboardStats(),
    prisma.user.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.user.count({ where: { createdAt: { gte: startOfPrevMonth, lt: startOfMonth } } }),
    prisma.reservation.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.reservation.count({ where: { createdAt: { gte: startOfPrevMonth, lt: startOfMonth } } }),
    prisma.reservation.aggregate({
      where: { state: "DONE", createdAt: { gte: startOfMonth } },
      _sum: { totalAmount: true },
    }),
    prisma.residence.count({ where: { state: "PENDING" } }),
    prisma.reservation.count({ where: { state: "HOST_APPROVAL" } }),
    // one row per month: reservation count + revenue (raw SQL — Prisma has no
    // date_trunc grouping)
    // NB: Reservation.createdAt has no @map, so the column is camelCase and
    // must stay quoted exactly as "createdAt".
    prisma.$queryRaw<{ month: Date; reservations: bigint; revenue: number | null }[]>`
      SELECT date_trunc('month', "createdAt") AS month,
             COUNT(*) AS reservations,
             SUM("total_amount") FILTER (WHERE state = 'DONE') AS revenue
      FROM reservations
      WHERE "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, phone: true, avatarUrl: true, isHost: true, createdAt: true },
    }),
    prisma.reservation.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        reference: true,
        state: true,
        totalAmount: true,
        createdAt: true,
        guest: { select: { name: true, phone: true } },
        residence: { select: { name: true } },
      },
    }),
  ]);

  const pct = (cur: number, prev: number) =>
    prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);

  return {
    ...base,
    newUsersThisMonth,
    newUsersChangePct: pct(newUsersThisMonth, newUsersPrevMonth),
    reservationsThisMonth,
    reservationsChangePct: pct(reservationsThisMonth, reservationsPrevMonth),
    revenueThisMonth: revenueThisMonth._sum.totalAmount ?? 0,
    pendingResidences,
    pendingReservations,
    trend: trendRows.map((r) => ({
      month: r.month.toISOString().slice(0, 7),
      reservations: Number(r.reservations),
      revenue: Number(r.revenue ?? 0),
    })),
    recentUsers,
    recentReservations,
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
  locationId: true,
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
  isActive: true,
  isSpecialHost: true,
  commissionPercent: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The admin user list's tab filter ("همه کاربران / میزبان‌ها / مهمان‌ها").
export type UserRoleTab = "all" | "hosts" | "guests" | "admins";

function userTabWhere(tab: UserRoleTab | undefined): Prisma.UserWhereInput {
  switch (tab) {
    case "hosts":
      return { isHost: true };
    case "guests":
      return { isHost: false, role: "USER" };
    case "admins":
      return { role: "ADMIN" };
    default:
      return {};
  }
}

export async function listUsers(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  tab?: UserRoleTab;
  isActive?: boolean;
  verificationStatus?: "NOT_CONFIRMED" | "CHECKING" | "CONFIRMED";
  sort?: "newest" | "oldest" | "reservations" | "name";
}) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.UserWhereInput = {
    ...userTabWhere(params.tab),
    ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
    ...(params.verificationStatus ? { verificationStatus: params.verificationStatus } : {}),
    ...(params.q
      ? {
          OR: [
            { phone: { contains: params.q } },
            { name: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
            { nationalCode: { contains: params.q } },
          ],
        }
      : {}),
  };

  const orderBy: Prisma.UserOrderByWithRelationInput =
    params.sort === "oldest"
      ? { createdAt: "asc" }
      : params.sort === "name"
        ? { name: "asc" }
        : params.sort === "reservations"
          ? { reservationsAsGuest: { _count: "desc" } }
          : { createdAt: "desc" };

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take,
      orderBy,
      select: {
        ...USER_SELECT_BASE,
        // list-card metrics (successful reservations / last reservation)
        _count: { select: { reservationsAsGuest: true, residences: true, yellowCards: true } },
        reservationsAsGuest: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    items: items.map(({ _count, reservationsAsGuest, ...u }) => ({
      ...u,
      reservationsCount: _count.reservationsAsGuest,
      residencesCount: _count.residences,
      yellowCardsCount: _count.yellowCards,
      lastReservationAt: reservationsAsGuest[0]?.createdAt ?? null,
    })),
  };
}

// Counts for the user-list tabs (rendered as pills above the table).
export async function userTabCounts() {
  const [all, hosts, guests, admins] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isHost: true } }),
    prisma.user.count({ where: { isHost: false, role: "USER" } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
  ]);
  return { all, hosts, guests, admins };
}

export async function getUser(id: number) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      ...USER_SELECT_BASE,
      location: { include: { parent: true } },
      bankAccount: true,
      residences: {
        select: {
          id: true,
          reference: true,
          name: true,
          state: true,
          averageRating: true,
          weekPrice: true,
          images: { take: 1, orderBy: { sortOrder: "asc" } },
          location: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      yellowCards: { orderBy: { createdAt: "desc" } },
      _count: { select: { reservationsAsGuest: true, reservationsAsHost: true } },
    },
  });

  // Header metrics for the detail page: successful stays, money moved, and
  // the latest activity timestamp.
  const [guestDone, hostDone, guestSpend, hostIncome, lastReservation] = await Promise.all([
    prisma.reservation.count({ where: { guestId: id, state: "DONE" } }),
    prisma.reservation.count({ where: { hostId: id, state: "DONE" } }),
    prisma.reservation.aggregate({
      where: { guestId: id, state: { in: ["SECOND_PAYMENT", "DONE"] } },
      _sum: { totalAmount: true },
    }),
    prisma.reservation.aggregate({
      where: { hostId: id, state: { in: ["SECOND_PAYMENT", "DONE"] } },
      _sum: { totalAmount: true },
    }),
    prisma.reservation.findFirst({
      where: { OR: [{ guestId: id }, { hostId: id }] },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    ...user,
    stats: {
      reservationsAsGuest: user._count.reservationsAsGuest,
      reservationsAsHost: user._count.reservationsAsHost,
      successfulAsGuest: guestDone,
      successfulAsHost: hostDone,
      totalSpent: guestSpend._sum.totalAmount ?? 0,
      totalIncome: hostIncome._sum.totalAmount ?? 0,
      lastActivityAt: lastReservation?.createdAt ?? null,
    },
  };
}

// Admin-created user (the "ایجاد کاربر جدید" form). Password optional —
// without one the user signs in via OTP like any migrated user.
export async function createUser(data: {
  phone: string;
  name?: string;
  email?: string;
  nationalCode?: string;
  contactPhone?: string;
  birthDay?: number;
  birthMonth?: number;
  birthYear?: number;
  address?: string;
  isHost?: boolean;
  password?: string;
}) {
  const existing = await prisma.user.findUnique({ where: { phone: data.phone } });
  if (existing) throw AppError.badRequest("کاربری با این شماره موبایل از قبل وجود دارد");

  const { password, ...fields } = data;
  return prisma.user.create({
    data: {
      ...fields,
      ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
    },
    select: USER_SELECT_BASE,
  });
}

export async function setUserPassword(id: number, password: string) {
  await prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  return { success: true };
}

export async function addYellowCard(userId: number, reason: string, adminId?: number) {
  return prisma.userYellowCard.create({ data: { userId, reason, adminId } });
}

export async function removeYellowCard(id: number) {
  await prisma.userYellowCard.delete({ where: { id } });
  return { success: true };
}

export async function updateUser(
  id: number,
  data: {
    isHost?: boolean;
    isActive?: boolean;
    isSpecialHost?: boolean;
    /** Their own commission rate; null puts them back on the site-wide one. */
    commissionPercent?: number | null;
    role?: "USER" | "ADMIN";
    verificationStatus?: "NOT_CONFIRMED" | "CHECKING" | "CONFIRMED";
    // profile fields, editable from the admin detail page
    name?: string;
    email?: string;
    nationalCode?: string;
    contactPhone?: string;
    emergencyPhone?: string;
    address?: string;
    job?: string;
    education?: string;
    description?: string;
    birthDay?: number;
    birthMonth?: number;
    birthYear?: number;
    cityId?: number | null;
  }
) {
  return prisma.user.update({ where: { id }, data, select: USER_SELECT_BASE });
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
  type: { label: "نوع ملک", type: "enum", enumValues: [...RESIDENCE_TYPES] },
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
      where.location = { name: { contains: String(f.value), mode: "insensitive" } };
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

// Residence list tabs ("همه اقامتگاه‌ها / ویلا و سوئیت / بوم‌گردی‌ها /
// در انتظار تایید").
export type ResidenceTab = "all" | "suit" | "boomgardi" | "hotel" | "pending";

function residenceTabWhere(tab: ResidenceTab | undefined): Prisma.ResidenceWhereInput {
  switch (tab) {
    case "suit":
      return { type: "SUIT" };
    case "boomgardi":
      return { type: "BOOMGARDI" };
    case "hotel":
      return { type: "HOTEL" };
    case "pending":
      return { state: "PENDING" };
    default:
      return {};
  }
}

export async function listResidences(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  state?: string;
  tab?: ResidenceTab;
  sort?: "newest" | "oldest" | "price_asc" | "price_desc" | "importance" | "rating";
  filters?: FilterCondition[];
}) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.ResidenceWhereInput = {
    ...residenceTabWhere(params.tab),
    ...(params.state ? { state: params.state as ResidenceState } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { reference: { contains: params.q, mode: "insensitive" } },
            { host: { phone: { contains: params.q } } },
            { host: { name: { contains: params.q, mode: "insensitive" } } },
          ],
        }
      : {}),
    ...(params.filters?.length ? buildResidenceFilterWhere(params.filters) : {}),
  };

  const orderBy: Prisma.ResidenceOrderByWithRelationInput =
    params.sort === "oldest"
      ? { createdAt: "asc" }
      : params.sort === "price_asc"
        ? { weekPrice: "asc" }
        : params.sort === "price_desc"
          ? { weekPrice: "desc" }
          : params.sort === "importance"
            ? { importance: "desc" }
            : params.sort === "rating"
              ? { averageRating: "desc" }
              : { createdAt: "desc" };

  const [total, items] = await Promise.all([
    prisma.residence.count({ where }),
    prisma.residence.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        host: { select: { id: true, name: true, phone: true } },
        location: { include: { parent: { select: { name: true, type: true } } } },
        images: { take: 1, orderBy: { sortOrder: "asc" } },
        _count: { select: { rooms: true, reservations: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    items: items.map(({ _count, ...r }) => ({
      ...r,
      // legacy-URL contract: the public id is the Odoo id for migrated rows
      publicId: publicResidenceId(r),
      roomsCount: _count.rooms,
      reservationsCount: _count.reservations,
    })),
  };
}

export async function residenceTabCounts() {
  const [all, suit, boomgardi, hotel, pending] = await Promise.all([
    prisma.residence.count(),
    prisma.residence.count({ where: { type: "SUIT" } }),
    prisma.residence.count({ where: { type: "BOOMGARDI" } }),
    prisma.residence.count({ where: { type: "HOTEL" } }),
    prisma.residence.count({ where: { state: "PENDING" } }),
  ]);
  return { all, suit, boomgardi, hotel, pending };
}

// ---------- Bulk actions (list-view multi-select) ----------

export async function bulkUpdateResidenceState(ids: number[], state: ResidenceState) {
  const result = await prisma.residence.updateMany({
    where: { id: { in: ids } },
    data: { state, ...(state === "PUBLISHED" ? { published: true } : { published: false }) },
  });
  return { updated: result.count };
}

/** Sets "نوع ملک" on the selection (the row menu's type entries). */
export async function bulkUpdateResidenceType(ids: number[], type: ResidenceType) {
  const result = await prisma.residence.updateMany({ where: { id: { in: ids } }, data: { type } });
  return { updated: result.count };
}

// Soft delete — keeps reservation history intact.
export async function bulkDeleteResidences(ids: number[]) {
  const result = await prisma.residence.updateMany({
    where: { id: { in: ids } },
    data: { state: "DELETED", published: false },
  });
  return { deleted: result.count };
}

/** Duplicates residences (specs + amenities + rules + rooms) as new drafts. */
export async function bulkCopyResidences(ids: number[]) {
  let copied = 0;
  for (const id of ids) {
    const src = await prisma.residence.findUnique({
      where: { id },
      include: { amenities: true, rules: true, rooms: true },
    });
    if (!src) continue;

    const {
      id: _id,
      reference,
      createdAt,
      updatedAt,
      amenities,
      rules,
      rooms,
      // nullable Json columns: Prisma's create input rejects a plain `null`,
      // so they're re-applied below via `?? undefined`
      extraRules,
      boomgardiFeatures,
      ...fields
    } = src;
    await prisma.residence.create({
      data: {
        ...fields,
        extraRules: extraRules ?? undefined,
        boomgardiFeatures: boomgardiFeatures ?? undefined,
        name: `${src.name} (کپی)`,
        reference: generateReference("RES-"),
        state: "DRAFT",
        published: false,
        amenities: {
          create: amenities.map((a) => ({
            amenityId: a.amenityId,
            extraFeatures: a.extraFeatures ?? undefined,
          })),
        },
        rules: { create: rules.map((r) => ({ ruleId: r.ruleId, value: r.value ?? undefined })) },
        rooms: {
          create: rooms.map(({ id: _rid, residenceId, ...room }) => room),
        },
      },
    });
    copied++;
  }
  return { copied };
}

/** CSV export for the current selection (UTF-8 BOM so Excel reads Persian). */
export async function exportResidencesCsv(ids: number[]) {
  const rows = await prisma.residence.findMany({
    where: { id: { in: ids } },
    include: {
      host: { select: { name: true, phone: true } },
      location: { include: { parent: { select: { name: true, type: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const header = [
    "کد",
    "نام اقامتگاه",
    "نوع",
    "وضعیت",
    "استان",
    "شهر",
    "میزبان",
    "شماره میزبان",
    "قیمت هفته",
    "امتیاز",
    "تاریخ ایجاد",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      publicResidenceId(r),
      r.name,
      RESIDENCE_TYPE_LABEL[r.type],
      r.state,
      r.location?.parent?.type === "PROVINCE" ? r.location.parent.name : "",
      r.location?.name ?? "",
      r.host?.name ?? "",
      r.host?.phone ?? "",
      r.weekPrice ?? 0,
      r.averageRating ?? 0,
      r.createdAt.toISOString().slice(0, 10),
    ]
      .map(esc)
      .join(",")
  );

  return "﻿" + [header.map(esc).join(","), ...lines].join("\r\n");
}

export async function getResidence(id: number) {
  const residence = await prisma.residence.findUniqueOrThrow({
    where: { id },
    include: {
      host: {
        select: {
          id: true,
          name: true,
          phone: true,
          avatarUrl: true,
          verificationStatus: true,
          isSpecialHost: true,
          _count: { select: { residences: true } },
        },
      },
      location: { include: { parent: true } },
      images: { orderBy: { sortOrder: "asc" } },
      distances: { orderBy: { sortOrder: "asc" } },
      extraLocations: { include: { location: { select: { id: true, name: true } } } },
      rooms: true,
      amenities: { include: { amenity: { include: { features: true } } } },
      rules: { include: { rule: true } },
      _count: { select: { reservations: true, reviews: true } },
    },
  });

  const { _count, host, ...rest } = residence;
  return {
    ...rest,
    // legacy-URL contract: the public "کد اقامتگاه" is the Odoo id
    publicId: publicResidenceId(residence),
    //  is a JSON blob on 2,555 of the 2,557 migrated listings that
    // have it. These two are the readable parts of it — see hostRules.ts.
    hostRulesText: hostRulesText(residence.rulesDesc, residence.extraRules),
    hostRuleNotes: hostRuleNotes(residence.rulesDesc, residence.extraRules),
    host: host && {
      ...host,
      residencesCount: host._count.residences,
    },
    reservationsCount: _count.reservations,
    reviewsCount2: _count.reviews,
  };
}

/** Replaces the residence-detail "فاصله تا جاذبه‌های گردشگری" list. */
export async function setResidenceDistances(
  id: number,
  distances: { placeName: string; distance?: string; eta?: string }[]
) {
  await prisma.residenceDistance.deleteMany({ where: { residenceId: id } });
  if (distances.length) {
    await prisma.residenceDistance.createMany({
      data: distances.map((d, i) => ({ residenceId: id, ...d, sortOrder: i })),
    });
  }
  return prisma.residenceDistance.findMany({ where: { residenceId: id }, orderBy: { sortOrder: "asc" } });
}

/** Replaces "دیگر شهرهای اقامتگاه" — the extra locations this listing appears under. */
export async function setResidenceExtraCities(id: number, cityIds: number[]) {
  await prisma.residenceLocation.deleteMany({ where: { residenceId: id } });
  if (cityIds.length) {
    await prisma.residenceLocation.createMany({
      data: cityIds.map((locationId) => ({ residenceId: id, locationId })),
      skipDuplicates: true,
    });
  }
  return prisma.residenceLocation.findMany({
    where: { residenceId: id },
    include: { location: { select: { id: true, name: true } } },
  });
}

export async function setResidenceState(id: number, state: ResidenceState) {
  const updated = await prisma.residence.update({
    where: { id },
    data: { state, published: state === "PUBLISHED" },
  });

  // The host asked for a decision and is waiting on it. Only the two states
  // that answer that question notify; the rest are internal bookkeeping.
  if (state === "PUBLISHED" || state === "REJECTED") {
    notify.onResidenceReviewed(id, state === "PUBLISHED");
  }

  return updated;
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

// A residence points at wherever it actually sits, which is sometimes a
// neighbourhood or a village, so the city is the nearest CITY going up the
// breadcrumb chain rather than whatever location the listing names directly.
const CITY_CHAIN_SELECT = {
  select: {
    name: true,
    type: true,
    parent: {
      select: {
        name: true,
        type: true,
        parent: { select: { name: true, type: true } },
      },
    },
  },
} as const;

type CityChain = { name: string; type: LocationType; parent?: CityChain | null } | null;

function cityOf(location: CityChain): string | null {
  for (let node: CityChain = location; node; node = node.parent ?? null) {
    if (node.type === "CITY") return node.name;
  }
  // Nothing in the chain is a city — a REGION, or a listing pinned at province
  // level. The place it does have beats an empty cell.
  return location?.name ?? null;
}

export async function listReservations(params: {
  page?: number;
  pageSize?: number;
  state?: string;
  q?: string;
}) {
  const { page, pageSize, skip, take } = parsePagination(params);

  // Finding one booking among 29,659 by paging is 1,483 pages. The search
  // covers the four things anyone actually has to hand when they go looking:
  // the code on the invoice, and either party's name or phone.
  const q = params.q?.trim();

  const where: Prisma.ReservationWhereInput = {
    ...(params.state ? { state: params.state as ReservationState } : {}),
    ...(q
      ? {
          OR: [
            { reference: { contains: q, mode: "insensitive" } },
            { guest: { phone: { contains: q } } },
            { guest: { name: { contains: q, mode: "insensitive" } } },
            { host: { phone: { contains: q } } },
            { host: { name: { contains: q, mode: "insensitive" } } },
            { residence: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        residence: { select: { id: true, name: true, location: CITY_CHAIN_SELECT } },
        guest: { select: { id: true, name: true, phone: true } },
        host: { select: { id: true, name: true, phone: true } },
      },
    }),
  ]);

  // "How many bookings had this guest made before this one" — the panel's
  // repeat-guest signal. One count per row rather than one grouped count: the
  // same guest can appear twice on a page and each of those rows has a
  // different answer. The page is 20 rows and `guest_id` is indexed.
  const previousCounts = await Promise.all(
    items.map((r) =>
      prisma.reservation.count({
        where: { guestId: r.guestId, createdAt: { lt: r.createdAt } },
      })
    )
  );

  return {
    total,
    page,
    pageSize,
    items: items.map((r, i) => ({
      ...r,
      city: cityOf(r.residence.location),
      guestPreviousCount: previousCounts[i],
    })),
  };
}

/**
 * The admin's view of one booking.
 *
 * `RESERVATION_INCLUDE` is shared with the guest- and host-facing endpoints,
 * so it deliberately carries nothing but a name, a phone and an avatar for the
 * two people. The panel needs more than that — a wallet balance, whether the
 * documents are verified, how the host is rated — and widening the shared
 * include would hand all of it to the other side of the booking as well.
 *
 * So it is fetched separately and attached as `guestProfile` / `hostProfile`.
 */
export async function getReservation(id: number) {
  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: { id },
    include: RESERVATION_INCLUDE,
  });

  const [guestProfile, hostProfile] = await Promise.all([
    partyProfile(reservation.guestId),
    partyProfile(reservation.hostId, { withHostRating: true }),
  ]);

  return { ...reservation, guestProfile, hostProfile };
}

/** The extra columns the reservation page shows about a guest or a host. */
async function partyProfile(userId: number, opts: { withHostRating?: boolean } = {}) {
  const [user, wallet, rating] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nationalCode: true,
        nationalCardUrl: true,
        verificationStatus: true,
        isSpecialHost: true,
        isHost: true,
        createdAt: true,
        location: { select: { name: true } },
      },
    }),
    prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true, blockedBalance: true },
    }),
    opts.withHostRating
      ? prisma.residence.aggregate({
          where: { hostId: userId },
          _avg: { averageRating: true },
          _sum: { reviewsCount: true },
          _count: true,
        })
      : Promise.resolve(null),
  ]);

  if (!user) return null;

  return {
    ...user,
    // A missing wallet row means the user has never had a transaction, which
    // is a zero balance rather than an unknown one.
    walletBalance: wallet?.balance ?? 0,
    walletBlocked: wallet?.blockedBalance ?? 0,
    ...(rating
      ? {
          hostRating: rating._avg.averageRating ?? 0,
          hostReviewsCount: rating._sum.reviewsCount ?? 0,
          residencesCount: rating._count,
        }
      : {}),
  };
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

  // Bookings made before the commission rules existed carry no split at all.
  // Filling it in here rather than skipping them is the difference between a
  // host being paid late and a host never being paid: the credit below reads
  // `hostShare`, and a null one silently pays nothing.
  const split =
    reservation.hostShare == null
      ? await reservationSettings.breakdownForHost(reservation.hostId, reservation.totalAmount)
      : null;

  const done = await prisma.reservation.update({
    where: { id },
    data: {
      state: "DONE",
      paidAmount: reservation.totalAmount + (reservation.guestCommission ?? split?.guestCommission ?? 0),
      remainingAmount: 0,
      ...(split
        ? {
            websiteShare: split.websiteShare,
            vatAmount: split.vatAmount,
            guestCommission: split.guestCommission,
            hostShare: split.hostShare,
            commissionPercent: split.commissionPercent,
            vatPercent: split.vatPercent,
            guestCommissionPercent: split.guestCommissionPercent,
          }
        : {}),
    },
    include: RESERVATION_INCLUDE,
  });

  // The host's share lands in the wallet, held rather than withdrawable: the
  // booking is paid for, but the guest has not arrived yet and a cancellation
  // still has to be able to take it back. `releaseMaturedEarnings` moves it to
  // the withdrawable balance on the day the stay starts.
  //
  // `hostShare` is whatever was recorded on the booking — from the Odoo
  // migration, from the rates in force when it was made, or filled in just
  // above. Nothing is recomputed against today's rates here: a second opinion
  // on what the host is owed is exactly how two numbers start disagreeing.
  //
  // Awaited, unlike the chat and notification hooks: this one is money. If it
  // fails, marking the reservation done should fail too, so the two cannot end
  // up out of step.
  if (done.hostShare && done.hostShare > 0) {
    await walletService.credit({
      userId: done.hostId,
      kind: "BOOKING_INCOME",
      amount: done.hostShare,
      description: `درآمد رزرو ${done.reference}`,
      reservationId: done.id,
      blocked: true,
    });
  }

  return done;
}

/**
 * Moves held earnings to the withdrawable balance once a stay has matured.
 *
 * Maturity is the day the guest checks in, not the day they leave: by then the
 * guest has arrived and the booking is no longer going to fall through, which
 * is the only thing the hold was ever protecting against. Odoo settled on the
 * same point — its host credits landed on average 2.2 days *before* the start
 * date. `releaseOnStartDate` can push it back to check-out.
 *
 * Split from markDone because it happens on a date, not on an action. There is
 * no scheduler in this project yet, so it is exposed to the admin panel and
 * meant to be called on a cron once there is one — it is idempotent, so
 * running it twice in a day costs one query and changes nothing.
 */
export async function releaseMaturedEarnings() {
  const { releaseOnStartDate } = await reservationSettings.getSettings();
  const now = new Date();

  const matured = await prisma.reservation.findMany({
    where: {
      state: "DONE",
      ...(releaseOnStartDate ? { startDate: { lte: now } } : { endDate: { lt: now } }),
      // Only the ones whose income is still held.
      walletTransactions: { some: { kind: "BOOKING_INCOME" } },
    },
    select: { id: true, hostId: true, reference: true, hostShare: true },
    take: 200,
  });

  let released = 0;
  for (const reservation of matured) {
    const amount = reservation.hostShare ?? 0;
    if (amount <= 0) continue;

    try {
      await walletService.release(
        reservation.hostId,
        amount,
        `آزادسازی درآمد رزرو ${reservation.reference}`
      );
      released++;
    } catch {
      // Already released, or the held balance no longer covers it because a
      // refund took it back. Neither is an error worth failing the batch for.
    }
  }

  return { checked: matured.length, released };
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

// "روزهای پیک" — global peak-date ranges used by pricing.
export const peakDays = {
  list: () =>
    prisma.peakDay.findMany({
      include: { locations: { include: { location: { select: { id: true, name: true } } } } },
      orderBy: { startDate: "desc" },
    }),
  create: ({ cityIds, ...data }: any) =>
    prisma.peakDay.create({
      data: {
        ...data,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        ...(cityIds?.length ? { locations: { create: cityIds.map((locationId: number) => ({ locationId })) } } : {}),
      },
      include: { locations: { include: { location: { select: { id: true, name: true } } } } },
    }),
  update: async (id: number, { cityIds, ...data }: any) => {
    if (cityIds) await prisma.peakDayLocation.deleteMany({ where: { peakDayId: id } });
    return prisma.peakDay.update({
      where: { id },
      data: {
        ...data,
        ...(data.startDate ? { startDate: new Date(data.startDate) } : {}),
        ...(data.endDate ? { endDate: new Date(data.endDate) } : {}),
        ...(cityIds?.length ? { locations: { create: cityIds.map((locationId: number) => ({ locationId })) } } : {}),
      },
      include: { locations: { include: { location: { select: { id: true, name: true } } } } },
    });
  },
  remove: (id: number) => prisma.peakDay.delete({ where: { id } }),
};

// Kept under the old names so existing admin routes keep working; both now
// read the one location tree, filtered by type.
export const cities = {
  list: () => prisma.location.findMany({ where: { type: "CITY" }, include: { parent: true } }),
  create: (data: Prisma.LocationCreateInput) => prisma.location.create({ data: { ...data, type: "CITY" } }),
  update: (id: number, data: Prisma.LocationUpdateInput) => prisma.location.update({ where: { id }, data }),
  remove: (id: number) => prisma.location.delete({ where: { id } }),
};

export const provinces = {
  list: () => prisma.location.findMany({ where: { type: "PROVINCE" } }),
  create: (data: Prisma.LocationCreateInput) => prisma.location.create({ data: { ...data, type: "PROVINCE" } }),
  update: (id: number, data: Prisma.LocationUpdateInput) => prisma.location.update({ where: { id }, data }),
  remove: (id: number) => prisma.location.delete({ where: { id } }),
};
