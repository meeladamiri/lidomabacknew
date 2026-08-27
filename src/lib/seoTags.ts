// Data-driven SEO tags.
//
// These used to be four hardcoded, mutually inconsistent tables — TAG_TITLES,
// SUGGESTED_TAGS and TAG_AMENITY_FILTERS/BINARY_AMENITY_KEYS/RULE_KEYS in the
// search service, plus a fifth copy (RELATED_TAG_RULES) in the residences
// service. They also disagreed with Odoo: `pool` filtered on استخر alone where
// production required استخر AND خانه ویلایی. Definitions now live in seo_tags /
// seo_tag_conditions, imported verbatim from Odoo's website_tags.x_domain.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SeoTag, SeoTagCondition } from "@prisma/client";

export type TagWithConditions = SeoTag & { conditions: SeoTagCondition[] };

// Tags change only when an admin edits them, but are read on every search.
const TTL_MS = 60_000;
let cache: { at: number; tags: TagWithConditions[] } | null = null;

export async function getSeoTags(): Promise<TagWithConditions[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tags;
  const tags = await prisma.seoTag.findMany({
    include: { conditions: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  cache = { at: Date.now(), tags };
  return tags;
}

/** Call after any admin write so the next search sees the change. */
export function invalidateSeoTagCache() {
  cache = null;
}

export async function getActiveSeoTags(): Promise<TagWithConditions[]> {
  return (await getSeoTags()).filter((t) => t.isActive);
}

export async function findSeoTagByKey(key: string): Promise<TagWithConditions | null> {
  return (await getSeoTags()).find((t) => t.key === key) ?? null;
}

/**
 * Translates one tag into a Prisma filter.
 *
 * Conditions sharing a groupIndex are OR-ed; groups are AND-ed. That is exactly
 * Odoo's domain shape — e.g. `village` is
 *   خانه روستایی AND (روستایی OR حومه شهر)
 *
 * A categorical condition carries the value it must match (نوع اقامتگاه =
 * "خانه ویلایی"); a binary amenity carries none, because a "ندارد" link is never
 * stored — presence of the link IS the answer.
 */
export function tagToWhere(tag: TagWithConditions): Prisma.ResidenceWhereInput[] {
  const clauses: Prisma.ResidenceWhereInput[] = [];

  const groups = new Map<number, SeoTagCondition[]>();
  for (const c of tag.conditions) {
    if (!groups.has(c.groupIndex)) groups.set(c.groupIndex, []);
    groups.get(c.groupIndex)!.push(c);
  }

  for (const conds of groups.values()) {
    const alternatives = conds.map((c) => conditionToWhere(c));
    clauses.push(alternatives.length === 1 ? alternatives[0] : { OR: alternatives });
  }

  if (tag.residenceType) clauses.push({ type: tag.residenceType });
  if (tag.matchIsFast) clauses.push({ isFast: true });
  if (tag.priceMin !== null || tag.priceMax !== null) {
    clauses.push({
      weekPrice: {
        ...(tag.priceMin !== null ? { gt: tag.priceMin } : {}),
        ...(tag.priceMax !== null ? { lte: tag.priceMax } : {}),
      },
    });
  }

  return clauses;
}

function conditionToWhere(c: SeoTagCondition): Prisma.ResidenceWhereInput {
  if (c.ruleKey) {
    return { rules: { some: { rule: { key: c.ruleKey }, value: { equals: "بله" } } } };
  }
  return {
    amenities: {
      some: {
        amenity: { key: c.amenityKey ?? "" },
        ...(c.valueName
          ? { extraFeatures: { path: ["value"], string_contains: c.valueName } }
          : {}),
      },
    },
  };
}

/**
 * Filter keys the search modal sends that are not SEO tags — plain amenity and
 * rule checkboxes (?jacuzzi=1, ?smoking=1). A tag of the same key wins, so the
 * curated definition beats the bare checkbox.
 */
export async function featureToWhere(key: string): Promise<Prisma.ResidenceWhereInput | null> {
  const tag = await findSeoTagByKey(key);
  if (tag && tag.isActive) {
    const clauses = tagToWhere(tag);
    return clauses.length ? { AND: clauses } : null;
  }

  const [amenity, rule] = await Promise.all([
    prisma.amenity.findUnique({ where: { key }, select: { id: true } }),
    prisma.rule.findUnique({ where: { key }, select: { id: true } }),
  ]);
  if (amenity) return { amenities: { some: { amenity: { key } } } };
  if (rule) return { rules: { some: { rule: { key }, value: { equals: "بله" } } } };
  return null; // unknown keys are ignored, as before
}
