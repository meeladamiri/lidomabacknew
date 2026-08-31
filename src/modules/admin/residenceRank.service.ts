import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * «رتبه در نتایج جستجوی این شهر».
 *
 * «اهمیت» is a bare number in the panel — 14,056,810 means nothing to the
 * person typing it, and the only way to find out what raising it did was to
 * open the public search and count. This answers the question the number is
 * actually asked in: where does this listing sit among the others in its city.
 *
 * The ordering here is copied from `search.service.ts`'s default «پیشنهاد
 * لیدوما» — importance, then rating, then newest — because a rank computed a
 * different way is a rank that does not match the page it claims to describe.
 * If that ordering changes, this has to change with it.
 */

/**
 * The city a listing sits in, walking up the breadcrumb: a residence can be
 * pinned to a neighbourhood or a village, and its competitors are the ones in
 * the same city, not the same lane.
 */
async function cityIdOf(locationId: number | null): Promise<number | null> {
  let id = locationId;
  for (let hops = 0; id && hops < 6; hops++) {
    const node = await prisma.location.findUnique({
      where: { id },
      select: { id: true, type: true, parentId: true },
    });
    if (!node) return null;
    if (node.type === "CITY") return node.id;
    id = node.parentId;
  }
  return locationId;
}

/** Every location id at or under a city — the search's own catchment. */
async function locationScope(cityId: number): Promise<number[]> {
  const children = await prisma.location.findMany({
    where: { parentId: cityId },
    select: { id: true },
  });
  return [cityId, ...children.map((c) => c.id)];
}

export async function rankInCity(residenceId: number, simulatedImportance?: number) {
  const residence = await prisma.residence.findUnique({
    where: { id: residenceId },
    select: {
      id: true,
      importance: true,
      averageRating: true,
      createdAt: true,
      locationId: true,
      state: true,
      location: { select: { id: true, name: true, type: true, parentId: true } },
    },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const cityId = await cityIdOf(residence.locationId);
  if (!cityId) {
    return {
      city: null,
      total: 0,
      current_rank: null,
      simulated_rank: null,
      importance: residence.importance,
      neighbours: [],
    };
  }

  const [city, scope] = await Promise.all([
    prisma.location.findUnique({ where: { id: cityId }, select: { id: true, name: true } }),
    locationScope(cityId),
  ]);

  // Only what a guest can actually find. Ranking against drafts and
  // deactivated listings would report a position nobody sees.
  const where = { locationId: { in: scope }, state: "PUBLISHED" as const };

  const total = await prisma.residence.count({ where });

  const rankFor = (importance: number) =>
    prisma.residence.count({
      where: {
        ...where,
        id: { not: residence.id },
        OR: [
          { importance: { gt: importance } },
          {
            importance,
            OR: [
              { averageRating: { gt: residence.averageRating } },
              { averageRating: residence.averageRating, createdAt: { gt: residence.createdAt } },
            ],
          },
        ],
      },
    });

  const [ahead, aheadSimulated] = await Promise.all([
    rankFor(residence.importance),
    simulatedImportance !== undefined && simulatedImportance !== residence.importance
      ? rankFor(simulatedImportance)
      : Promise.resolve(null),
  ]);

  // The listing itself is not in `ahead`, so its position is one past however
  // many beat it. A listing that is not published has no position at all.
  const published = residence.state === "PUBLISHED";

  const neighbours = await prisma.residence.findMany({
    where,
    select: { id: true, name: true, importance: true, averageRating: true },
    orderBy: [{ importance: "desc" }, { averageRating: "desc" }, { createdAt: "desc" }],
    skip: Math.max(ahead - 2, 0),
    take: 5,
  });

  return {
    city: city ? { id: city.id, name: city.name } : null,
    total,
    current_rank: published ? ahead + 1 : null,
    simulated_rank: aheadSimulated === null ? null : aheadSimulated + 1,
    importance: residence.importance,
    published,
    neighbours: neighbours.map((n, i) => ({
      ...n,
      rank: Math.max(ahead - 2, 0) + i + 1,
      isSelf: n.id === residence.id,
    })),
  };
}
