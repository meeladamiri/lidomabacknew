import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { parsePagination } from "@/utils/pagination";
import * as activity from "@/modules/activity/activity.service";
import type { Prisma } from "@prisma/client";

/**
 * جاذبه‌های گردشگری — the catalogue, and "what is near this listing".
 *
 * ## Why "nearby" has two answers
 *
 * The catalogue has 18,448 places but coordinates on only 720 of them, and
 * 8,523 of 9,574 listings have coordinates. So proximity is answerable for
 * some pairs and not others, and pretending otherwise would either hide most
 * of the catalogue or invent positions for it.
 *
 *   • **Both sides have coordinates** → a real distance, in kilometres,
 *     sorted nearest first. This is the answer worth having.
 *   • **Otherwise** → same city, by name. Not a distance, and the response
 *     says so rather than dressing it up as one.
 *
 * The panel shows which kind it got, because "۳ کیلومتر" and "in the same
 * city" are different promises to make to a guest.
 */

/** Metres per degree of latitude. Longitude is scaled by cos(lat). */
const KM_PER_DEG = 111.32;

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than the flat approximation: Iran spans 25°–40° north, and
 * a flat degree-grid is out by several percent at that latitude — enough to
 * reorder two attractions that are genuinely close together.
 */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** «۱۲٫۴ کیلومتر» — the shape the existing 14,866 rows already use. */
export function formatKm(km: number): string {
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${rounded.toLocaleString("fa-IR")} کیلومتر`;
}

// ------------------------------------------------------------- catalogue

export async function list(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  locationId?: number;
  /** "with" / "without" coordinates — the gap the ops team is filling in. */
  coords?: "with" | "without";
  onlyActive?: boolean;
}) {
  const { page, pageSize, skip, take } = parsePagination(params);

  const where: Prisma.AttractionWhereInput = {
    ...(params.onlyActive ? { isActive: true } : {}),
    ...(params.locationId ? { locationId: params.locationId } : {}),
    ...(params.coords === "with" ? { latitude: { not: null } } : {}),
    ...(params.coords === "without" ? { latitude: null } : {}),
    ...(params.q ? { name: { contains: params.q, mode: "insensitive" } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.attraction.count({ where }),
    prisma.attraction.findMany({
      where,
      skip,
      take,
      orderBy: [{ name: "asc" }],
      include: {
        location: { select: { id: true, name: true, parent: { select: { name: true } } } },
        _count: { select: { distances: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    items: items.map(({ _count, ...a }) => ({ ...a, usedByCount: _count.distances })),
  };
}

export async function counts() {
  const [total, withCoords, active] = await Promise.all([
    prisma.attraction.count(),
    prisma.attraction.count({ where: { latitude: { not: null } } }),
    prisma.attraction.count({ where: { isActive: true } }),
  ]);
  return { total, withCoords, withoutCoords: total - withCoords, active };
}

export async function create(
  data: {
    name: string;
    latitude?: number | null;
    longitude?: number | null;
    locationId?: number | null;
  },
  actorId: number
) {
  const attraction = await prisma.attraction.create({ data });
  activity.log({
    kind: "FIELD_CHANGE",
    summary: `جاذبه گردشگری «${attraction.name}» اضافه شد`,
    details: { attractionId: attraction.id, ...data },
    actorId,
    source: "ADMIN",
  });
  return attraction;
}

export async function update(
  id: number,
  data: {
    name?: string;
    latitude?: number | null;
    longitude?: number | null;
    locationId?: number | null;
    isActive?: boolean;
  },
  actorId: number
) {
  const before = await prisma.attraction.findUnique({ where: { id } });
  if (!before) throw AppError.notFound("جاذبه یافت نشد");

  const attraction = await prisma.attraction.update({ where: { id }, data });

  activity.log({
    kind: "FIELD_CHANGE",
    summary: `جاذبه گردشگری «${attraction.name}» ویرایش شد`,
    details: { attractionId: id, before, after: attraction },
    actorId,
    source: "ADMIN",
  });
  return attraction;
}

/**
 * Deactivates rather than deletes when the place is in use.
 *
 * A catalogue entry that 82 listings point at is not a row to drop: the
 * distances would survive (the FK is SET NULL) but the ops team would lose the
 * ability to see what they were, and re-adding it would not reconnect them.
 */
export async function remove(id: number, actorId: number) {
  const attraction = await prisma.attraction.findUnique({
    where: { id },
    include: { _count: { select: { distances: true } } },
  });
  if (!attraction) throw AppError.notFound("جاذبه یافت نشد");

  if (attraction._count.distances > 0) {
    const updated = await prisma.attraction.update({
      where: { id },
      data: { isActive: false },
    });
    activity.log({
      kind: "FIELD_CHANGE",
      summary: `جاذبه «${attraction.name}» غیرفعال شد (روی ${attraction._count.distances} اقامتگاه استفاده شده)`,
      details: { attractionId: id },
      actorId,
      source: "ADMIN",
    });
    return { deleted: false, deactivated: true, attraction: updated };
  }

  await prisma.attraction.delete({ where: { id } });
  activity.log({
    kind: "FIELD_CHANGE",
    summary: `جاذبه «${attraction.name}» حذف شد`,
    details: { attractionId: id },
    actorId,
    source: "ADMIN",
  });
  return { deleted: true, deactivated: false };
}

// ----------------------------------------------------------------- nearby

export interface NearbyAttraction {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  /** Kilometres, when both sides have coordinates. Null otherwise. */
  distanceKm: number | null;
  /** Ready to store on a distance row. Null when there is no real distance. */
  distanceText: string | null;
  /** Already attached to this listing. */
  alreadyAdded: boolean;
}

/**
 * Attractions near one listing.
 *
 * Coordinate matches first, ordered by real distance; then same-city entries
 * that have no coordinates, by name. A listing with no coordinates of its own
 * gets only the second kind — which is the honest result, not an empty list.
 */
export async function nearby(
  residenceId: number,
  options: { radiusKm?: number; limit?: number } = {}
): Promise<{ mode: "distance" | "city" | "mixed"; items: NearbyAttraction[] }> {
  const radiusKm = options.radiusKm ?? 30;
  const limit = options.limit ?? 20;

  const residence = await prisma.residence.findUnique({
    where: { id: residenceId },
    select: {
      latitude: true,
      longitude: true,
      locationId: true,
      distances: { select: { attractionId: true, placeName: true } },
    },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const attachedIds = new Set(
    residence.distances.map((d) => d.attractionId).filter((v): v is number => v != null)
  );
  // Rows migrated as free text have no attractionId, so a place already listed
  // under its own name would otherwise be offered again as a "suggestion".
  const attachedNames = new Set(residence.distances.map((d) => d.placeName.trim()));

  const hasCoords = residence.latitude != null && residence.longitude != null;

  const byDistance: NearbyAttraction[] = [];

  if (hasCoords) {
    // A bounding box first, so the coordinate scan is over a few rows rather
    // than all 720. Longitude degrees shrink with latitude, hence the cosine.
    const latDelta = radiusKm / KM_PER_DEG;
    const lngDelta =
      radiusKm / (KM_PER_DEG * Math.max(0.1, Math.cos((residence.latitude! * Math.PI) / 180)));

    const candidates = await prisma.attraction.findMany({
      where: {
        isActive: true,
        latitude: { not: null, gte: residence.latitude! - latDelta, lte: residence.latitude! + latDelta },
        longitude: { not: null, gte: residence.longitude! - lngDelta, lte: residence.longitude! + lngDelta },
      },
      include: { location: { select: { name: true } } },
      take: 500,
    });

    for (const a of candidates) {
      const km = haversineKm(residence.latitude!, residence.longitude!, a.latitude!, a.longitude!);
      if (km > radiusKm) continue;
      byDistance.push({
        id: a.id,
        name: a.name,
        latitude: a.latitude,
        longitude: a.longitude,
        locationName: a.location?.name ?? null,
        distanceKm: Math.round(km * 100) / 100,
        distanceText: formatKm(km),
        alreadyAdded: attachedIds.has(a.id) || attachedNames.has(a.name.trim()),
      });
    }
    byDistance.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  }

  const foundIds = new Set(byDistance.map((a) => a.id));
  const byCity: NearbyAttraction[] = [];

  if (residence.locationId && byDistance.length < limit) {
    // Through the relevance table, not `attraction.locationId`.
    //
    // Odoo's city was the city of the *listing that referenced the place*, so
    // that column would label ایستگاه راه آهن اصفهان as being in خور و بیابانک.
    // It survives only as the single most-common attribution, which is a label
    // and not an address. What the attributions do say — "listings in this
    // city point their guests here" — is the better suggestion anyway.
    //
    // The query starts from the link rows so it can order by the weight **for
    // this city**. Ordering the attractions by `cities._count` instead sorts
    // by how many cities a place is relevant to, which for Isfahan surfaced
    // "پایانه مسافربری" (referenced twice) above "پل خواجو" (referenced 23
    // times) — the opposite of what the number means.
    const links = await prisma.attractionCity.findMany({
      where: {
        locationId: residence.locationId,
        attractionId: { notIn: [...foundIds] },
        attraction: { isActive: true },
      },
      orderBy: { weight: "desc" },
      take: limit - byDistance.length,
      include: { attraction: { include: { location: { select: { name: true } } } } },
    });

    for (const a of links.map((l) => l.attraction)) {
      byCity.push({
        id: a.id,
        name: a.name,
        latitude: a.latitude,
        longitude: a.longitude,
        locationName: a.location?.name ?? null,
        // No coordinates on one side or the other: same city is all that can
        // be claimed, and it is not a distance.
        distanceKm: null,
        distanceText: null,
        alreadyAdded: attachedIds.has(a.id) || attachedNames.has(a.name.trim()),
      });
    }
  }

  const items = [...byDistance.slice(0, limit), ...byCity].slice(0, limit);
  const mode =
    byDistance.length && byCity.length ? "mixed" : byDistance.length ? "distance" : "city";

  return { mode, items };
}

// ------------------------------------------------- a listing's distance rows

export async function listDistances(residenceId: number) {
  return prisma.residenceDistance.findMany({
    where: { residenceId },
    orderBy: { sortOrder: "asc" },
    include: {
      attraction: {
        select: { id: true, name: true, latitude: true, longitude: true, isActive: true },
      },
    },
  });
}

/**
 * Adds one distance row, from the catalogue or typed by hand.
 *
 * `placeName` is stored either way. A row that only pointed at the catalogue
 * would render as nothing the day that entry is deactivated.
 */
export async function addDistance(
  residenceId: number,
  input: { attractionId?: number | null; placeName?: string; distance?: string; eta?: string },
  actorId: number
) {
  let placeName = input.placeName?.trim();
  let distance = input.distance?.trim() || null;

  if (input.attractionId) {
    const attraction = await prisma.attraction.findUnique({
      where: { id: input.attractionId },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    if (!attraction) throw AppError.notFound("جاذبه یافت نشد");
    placeName = placeName || attraction.name;

    // Compute the distance when nothing was supplied and both ends have
    // coordinates — the whole point of the catalogue.
    if (!distance && attraction.latitude != null && attraction.longitude != null) {
      const residence = await prisma.residence.findUnique({
        where: { id: residenceId },
        select: { latitude: true, longitude: true },
      });
      if (residence?.latitude != null && residence.longitude != null) {
        distance = formatKm(
          haversineKm(residence.latitude, residence.longitude, attraction.latitude, attraction.longitude)
        );
      }
    }
  }

  if (!placeName) throw AppError.badRequest("نام مکان الزامی است");

  const last = await prisma.residenceDistance.findFirst({
    where: { residenceId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const row = await prisma.residenceDistance.create({
    data: {
      residenceId,
      attractionId: input.attractionId ?? null,
      placeName,
      distance,
      eta: input.eta?.trim() || null,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId,
    summary: `فاصله تا «${placeName}» اضافه شد`,
    details: { distanceId: row.id, ...input },
    actorId,
    source: "ADMIN",
  });

  return row;
}

export async function updateDistance(
  id: number,
  data: { placeName?: string; distance?: string | null; eta?: string | null; sortOrder?: number },
  actorId: number
) {
  const before = await prisma.residenceDistance.findUnique({ where: { id } });
  if (!before) throw AppError.notFound("این ردیف یافت نشد");

  const row = await prisma.residenceDistance.update({ where: { id }, data });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: before.residenceId,
    summary: `فاصله تا «${row.placeName}» ویرایش شد`,
    details: { distanceId: id, before, after: row },
    actorId,
    source: "ADMIN",
  });
  return row;
}

export async function removeDistance(id: number, actorId: number) {
  const row = await prisma.residenceDistance.findUnique({ where: { id } });
  if (!row) throw AppError.notFound("این ردیف یافت نشد");

  await prisma.residenceDistance.delete({ where: { id } });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: row.residenceId,
    summary: `فاصله تا «${row.placeName}» حذف شد`,
    details: { distanceId: id, removed: row },
    actorId,
    source: "ADMIN",
  });
  return { removed: true };
}

/**
 * Adds several nearby attractions at once — the «افزودن خودکار» button.
 *
 * Skips anything already listed, by catalogue id or by name, so pressing it
 * twice does not double the list.
 */
export async function addNearbyBulk(
  residenceId: number,
  attractionIds: number[],
  actorId: number
) {
  const existing = await prisma.residenceDistance.findMany({
    where: { residenceId },
    select: { attractionId: true, placeName: true },
  });
  const haveIds = new Set(existing.map((d) => d.attractionId).filter(Boolean));
  const haveNames = new Set(existing.map((d) => d.placeName.trim()));

  const added: number[] = [];
  for (const attractionId of attractionIds) {
    if (haveIds.has(attractionId)) continue;
    const a = await prisma.attraction.findUnique({
      where: { id: attractionId },
      select: { name: true },
    });
    if (!a || haveNames.has(a.name.trim())) continue;
    const row = await addDistance(residenceId, { attractionId }, actorId);
    added.push(row.id);
    haveNames.add(a.name.trim());
  }

  return { added: added.length };
}
