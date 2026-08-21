import { Prisma } from "../../generated/prisma/client";
import { prisma } from "@/lib/prisma";

export async function getPopularDestinations() {
  // Cities ranked by number of published residences.
  const cities = await prisma.city.findMany({
    include: { _count: { select: { residences: true } } },
    orderBy: { residences: { _count: "desc" } },
    take: 12,
  });

  return cities.map((c) => ({
    id: c.id,
    name: c.name,
    titleEn: c.titleEn,
    image: c.imageUrl,
    count: c._count.residences,
    type: "city" as const,
  }));
}

export async function getProvincesAndCities() {
  const provinces = await prisma.province.findMany({
    include: { cities: { select: { name: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });

  return provinces.map((p) => ({
    id: p.id,
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    cities: p.cities.map((c) => c.name),
  }));
}

export async function searchCitiesAndProvinces(query: string) {
  const [cities, provinces] = await Promise.all([
    prisma.city.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
      include: { province: true, _count: { select: { residences: true } } },
      take: 10,
    }),
    prisma.province.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
      take: 5,
    }),
  ]);

  return {
    cities: cities.map((c) => ({
      id: c.id,
      name: c.name,
      titleEn: c.titleEn,
      type: "city" as const,
    })),
    provinces: provinces.map((p) => ({
      id: p.id,
      name: p.name,
      type: "province" as const,
    })),
  };
}

export interface ResidenceSearchFilters {
  cityId?: number;
  cityName?: string;
  startDate?: string;
  endDate?: string;
  guestsCount?: number;
  roomsCount?: number;
  minPrice?: number;
  maxPrice?: number;
  type?: "BOOMGARDI" | "SUIT";
  mapBounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  page?: number;
  pageSize?: number;
  order?: "price_asc" | "price_desc" | "rating_desc" | "newest";
}

export const RESIDENCE_CARD_SELECT = {
  id: true,
  reference: true,
  name: true,
  name2: true,
  type: true,
  averageRating: true,
  reviewsCount: true,
  isFast: true,
  isFull: true,
  isOffer: true,
  latitude: true,
  longitude: true,
  maxCapacity: true,
  capacity: true,
  weekPrice: true,
  weekendPrice: true,
  city: {
    select: {
      id: true,
      name: true,
      province: { select: { id: true, name: true } },
    },
  },
  neighborhood: true,
  images: { select: { url: true }, orderBy: { sortOrder: "asc" as const }, take: 5 },
  rooms: { select: { id: true } },
} satisfies Prisma.ResidenceSelect;

export function toCard(residence: Prisma.ResidenceGetPayload<{ select: typeof RESIDENCE_CARD_SELECT }>) {
  return {
    id: residence.id,
    reference: residence.reference,
    name: residence.name,
    name2: residence.name2,
    type: residence.type,
    averageRating: residence.averageRating,
    reviewsCount: residence.reviewsCount,
    isFast: residence.isFast,
    isFull: residence.isFull,
    isOffer: residence.isOffer,
    latitude: residence.latitude,
    longitude: residence.longitude,
    maxCapacity: residence.maxCapacity,
    capacity: residence.capacity,
    minPrice: residence.weekPrice,
    weekendPrice: residence.weekendPrice,
    city: residence.city?.name ?? null,
    province: residence.city?.province?.name ?? null,
    neighborhood: residence.neighborhood,
    images: residence.images.map((i: { url: string }) => i.url),
    mainImage: residence.images[0]?.url ?? null,
    roomsCount: residence.rooms.length,
  };
}

export async function searchResidences(filters: ResidenceSearchFilters) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;

  const where: Prisma.ResidenceWhereInput = {
    state: "PUBLISHED",
    published: true,
  };

  if (filters.cityId) where.cityId = filters.cityId;
  if (filters.cityName) where.city = { name: { contains: filters.cityName, mode: "insensitive" } };
  if (filters.type) where.type = filters.type;
  if (filters.guestsCount) where.maxCapacity = { gte: filters.guestsCount };
  if (filters.minPrice || filters.maxPrice) {
    where.weekPrice = {
      ...(filters.minPrice ? { gte: filters.minPrice } : {}),
      ...(filters.maxPrice ? { lte: filters.maxPrice } : {}),
    };
  }
  if (filters.mapBounds) {
    where.latitude = { gte: filters.mapBounds.minLat, lte: filters.mapBounds.maxLat };
    where.longitude = { gte: filters.mapBounds.minLng, lte: filters.mapBounds.maxLng };
  }

  // Availability filter: exclude residences that have a blocking calendar day
  // (at the residence level, i.e. roomId = null) inside the requested range.
  if (filters.startDate && filters.endDate) {
    where.calendarDays = {
      none: {
        roomId: null,
        isBlocked: true,
        date: { gte: new Date(filters.startDate), lt: new Date(filters.endDate) },
      },
    };
  }

  const orderBy: Prisma.ResidenceOrderByWithRelationInput =
    filters.order === "price_asc"
      ? { weekPrice: "asc" }
      : filters.order === "price_desc"
        ? { weekPrice: "desc" }
        : filters.order === "rating_desc"
          ? { averageRating: "desc" }
          : { createdAt: "desc" };

  const [total, residences] = await Promise.all([
    prisma.residence.count({ where }),
    prisma.residence.findMany({
      where,
      select: RESIDENCE_CARD_SELECT,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    items: residences.map(toCard),
  };
}
