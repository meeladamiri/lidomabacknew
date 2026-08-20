import {
  Prisma,
  ResidenceState,
  ReservationState,
} from "../../generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { parsePagination } from "@/utils/pagination";

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
    prisma.user.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
  ]);

  return { total, page, pageSize, items };
}

export async function getUser(id: number) {
  return prisma.user.findUniqueOrThrow({
    where: { id },
    include: {
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

export async function listResidences(params: { page?: number; pageSize?: number; q?: string; state?: string }) {
  const { page, pageSize, skip, take } = parsePagination(params);
  const where: Prisma.ResidenceWhereInput = {
    ...(params.state ? { state: params.state as ResidenceState } : {}),
    ...(params.q ? { name: { contains: params.q, mode: "insensitive" } } : {}),
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
    include: {
      residence: true,
      guest: { select: { id: true, name: true, phone: true } },
      host: { select: { id: true, name: true, phone: true } },
      rooms: { include: { room: true } },
    },
  });
}

// ---------- Catalogs ----------

export const amenities = {
  list: () => prisma.amenity.findMany({ include: { features: true } }),
  create: (data: Prisma.AmenityCreateInput) => prisma.amenity.create({ data }),
  update: (id: number, data: Prisma.AmenityUpdateInput) => prisma.amenity.update({ where: { id }, data }),
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
