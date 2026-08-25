// Slug resolution and result-set expansion for the location tree.
//
// Every indexed /search/<slug> URL depends on this file behaving exactly as the
// old flat City+Province lookup did — see scripts/verify-location-slugs.ts,
// which diffs slug -> place and slug -> listing count across the migration.

import { prisma } from "@/lib/prisma";
import type { Location, LocationType } from "@/generated/prisma/client";

/**
 * City wins over province, which is how the old code resolved
 * (`city.findFirst` then `province.findFirst`). Odoo already disambiguated the
 * real collisions by slug — city یزد is "yazd" while the province is "yazdp" —
 * but تهران has a province row with no slug at all, so precedence still decides
 * /search/tehran and must stay city-first.
 */
const TYPE_PRECEDENCE: LocationType[] = [
  "CITY",
  "PROVINCE",
  "REGION",
  "COUNTRY",
  "VILLAGE",
  "NEIGHBORHOOD",
];

/**
 * EVERY location a /search/<slug> segment matches, accepting the English slug
 * or the Persian name.
 *
 * A slug is not unique. Odoo let a city and its province share one
 * (isfahan is both اصفهان the city and اصفهان the province), and it holds
 * duplicate/misspelled city rows that share a slug too (درود and دورود are both
 * "dorud"; فيروزآباد with an Arabic ي alongside فیروزآباد). The old flat query
 * OR-ed city and province matches together, so those pages listed the union —
 * /search/isfahan showed the city AND the whole province, 652 listings.
 *
 * Returning only the best match would silently shrink 11 indexed pages
 * (isfahan 652 -> 243, ardabil 225 -> 57). Callers that need one canonical
 * place for SEO use resolveLocationBySlug; callers that build a result set use
 * this and union the expansions.
 */
export async function resolveLocationsBySlug(slug: string): Promise<Location[]> {
  const q = slug.trim();
  if (!q) return [];
  return prisma.location.findMany({
    where: { OR: [{ titleEn: { equals: q, mode: "insensitive" } }, { name: q }] },
  });
}

/** The single canonical place for a slug — drives the page's SEO identity. */
export async function resolveLocationBySlug(slug: string): Promise<Location | null> {
  const q = slug.trim();
  if (!q) return null;

  const matches = await resolveLocationsBySlug(q);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Prefer an exact slug hit over a name hit, then fall back to type order.
  const bySlug = matches.filter((m) => m.titleEn?.toLowerCase() === q.toLowerCase());
  const pool = bySlug.length ? bySlug : matches;
  for (const type of TYPE_PRECEDENCE) {
    const hit = pool.find((m) => m.type === type);
    if (hit) return hit;
  }
  return pool[0];
}

/**
 * Every location whose listings belong on this location's page.
 *
 * - A province spans its cities (as it always did).
 * - "شهرهای زیرمجموعه" (LocationInclude) pull in curated extras — this is what
 *   replaces the hardcoded REGION_ALIASES: شمال now includes مازندران/گیلان/گلستان
 *   as data, and each included province still expands to its own cities.
 * - A city does NOT absorb its children. Before the tree existed only provinces
 *   had children, so widening this would silently change high-traffic pages
 *   (سمنان would jump 8 -> 83 listings). Cross-location inclusion is opt-in via
 *   LocationInclude, which is exactly how the ops team described it.
 */
export async function expandLocationIds(locationId: number): Promise<number[]> {
  const ids = new Set<number>([locationId]);

  const includes = await prisma.locationInclude.findMany({
    where: { parentId: locationId },
    select: { childId: true },
  });
  includes.forEach((i) => ids.add(i.childId));

  // Any province in the set contributes its cities.
  const provinces = await prisma.location.findMany({
    where: { id: { in: [...ids] }, type: "PROVINCE" },
    select: { id: true },
  });
  if (provinces.length) {
    const cities = await prisma.location.findMany({
      where: { parentId: { in: provinces.map((p) => p.id) } },
      select: { id: true },
    });
    cities.forEach((c) => ids.add(c.id));
  }

  return [...ids];
}

/** Breadcrumb chain from the root down to (and including) this location. */
export async function locationBreadcrumb(locationId: number): Promise<Location[]> {
  const chain: Location[] = [];
  let current = await prisma.location.findUnique({ where: { id: locationId } });
  // Guard against a cycle: Odoo's tree had self-referencing rows.
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    if (!current.parentId) break;
    current = await prisma.location.findUnique({ where: { id: current.parentId } });
  }
  return chain;
}

/**
 * Union of expandLocationIds over every location a slug matches — the result
 * set behind /search/<slug>. See resolveLocationsBySlug for why a slug can
 * match more than one place.
 */
export async function expandSlugToLocationIds(slug: string): Promise<number[] | null> {
  const matches = await resolveLocationsBySlug(slug);
  if (!matches.length) return null;
  const ids = new Set<number>();
  for (const m of matches) {
    (await expandLocationIds(m.id)).forEach((id) => ids.add(id));
  }
  return [...ids];
}
