// URL-parity gate for the Province+City -> Location tree migration.
//
// Every indexed /search/<slug> URL must resolve to the same place and the same
// result set after the migration. This script snapshots that mapping, and
// diffs a later snapshot against it. ANY difference means the migration
// changed a public URL's meaning and must be fixed before shipping.
//
// It reads through raw SQL and auto-detects which schema is live (the legacy
// `cities`+`provinces` pair, or the merged `locations` table), so the exact
// same script produces the "before" and "after" snapshots.
//
// Resolution mirrors the two behaviours that URLs actually depend on, both in
// src/modules/search/search.service.ts:
//   - getSearchPageData(): city first (titleEn case-insensitive, or exact
//     name), then province. Decides the page's SEO identity.
//   - searchResidences(): a slug matches a city by titleEn/name-contains, OR
//     any city whose province matches the same way. Decides the result set.
//
// Usage:
//   npx tsx --env-file=.env scripts/verify-location-slugs.ts --save before.json
//   npx tsx --env-file=.env scripts/verify-location-slugs.ts --compare before.json

import { prisma } from "@/lib/prisma";
import { writeFileSync, readFileSync } from "node:fs";

const argv = process.argv;
const argOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SAVE = argOf("--save");
const COMPARE = argOf("--compare");

interface SlugEntry {
  slug: string;
  /** what getSearchPageData() would resolve this to */
  resolvedKind: "city" | "province" | "none";
  resolvedName: string | null;
  /** what searchResidences() would return for ?cat_name=<slug> */
  residenceCount: number;
}
type Snapshot = Record<string, SlugEntry>;

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = $1) AS exists`,
    name
  );
  return rows[0]?.exists === true;
}

/** Slug universe + per-slug resolution on the pre-migration schema. */
async function snapshotLegacy(): Promise<Snapshot> {
  const rows = await prisma.$queryRawUnsafe<
    { slug: string; kind: string; name: string; count: number }[]
  >(`
    WITH slugs AS (
      SELECT DISTINCT trim(title_en) AS slug FROM cities    WHERE title_en IS NOT NULL AND trim(title_en) <> ''
      UNION
      SELECT DISTINCT trim(title_en) AS slug FROM provinces WHERE title_en IS NOT NULL AND trim(title_en) <> ''
    ),
    resolved AS (
      SELECT s.slug,
        COALESCE(
          (SELECT 'city' FROM cities c
            WHERE lower(c.title_en) = lower(s.slug) OR c.name = s.slug LIMIT 1),
          (SELECT 'province' FROM provinces p
            WHERE lower(p.title_en) = lower(s.slug) OR p.name = s.slug LIMIT 1),
          'none'
        ) AS kind,
        COALESCE(
          (SELECT c.name FROM cities c
            WHERE lower(c.title_en) = lower(s.slug) OR c.name = s.slug LIMIT 1),
          (SELECT p.name FROM provinces p
            WHERE lower(p.title_en) = lower(s.slug) OR p.name = s.slug LIMIT 1)
        ) AS name
      FROM slugs s
    )
    SELECT r.slug, r.kind, r.name,
      (SELECT count(*) FROM residences res
         JOIN cities c ON c.id = res.city_id
         LEFT JOIN provinces p ON p.id = c.province_id
        WHERE res.state = 'PUBLISHED' AND res.published = true
          AND ( lower(c.title_en) = lower(r.slug)
             OR c.name ILIKE '%' || r.slug || '%'
             OR lower(p.title_en) = lower(r.slug)
             OR p.name ILIKE '%' || r.slug || '%' )
      )::int AS count
    FROM resolved r
    ORDER BY r.slug
  `);
  return Object.fromEntries(
    rows.map((r) => [
      r.slug,
      {
        slug: r.slug,
        resolvedKind: r.kind as SlugEntry["resolvedKind"],
        resolvedName: r.name,
        residenceCount: Number(r.count),
      },
    ])
  );
}

/** Same universe + resolution, expressed against the merged tree. */
async function snapshotLocations(): Promise<Snapshot> {
  const rows = await prisma.$queryRawUnsafe<
    { slug: string; kind: string; name: string; count: number }[]
  >(`
    WITH slugs AS (
      SELECT DISTINCT trim(title_en) AS slug FROM locations
       WHERE title_en IS NOT NULL AND trim(title_en) <> ''
         AND type IN ('CITY', 'PROVINCE')
    ),
    resolved AS (
      SELECT s.slug,
        COALESCE(
          (SELECT 'city' FROM locations l WHERE l.type = 'CITY'
            AND (lower(l.title_en) = lower(s.slug) OR l.name = s.slug) LIMIT 1),
          (SELECT 'province' FROM locations l WHERE l.type = 'PROVINCE'
            AND (lower(l.title_en) = lower(s.slug) OR l.name = s.slug) LIMIT 1),
          'none'
        ) AS kind,
        COALESCE(
          (SELECT l.name FROM locations l WHERE l.type = 'CITY'
            AND (lower(l.title_en) = lower(s.slug) OR l.name = s.slug) LIMIT 1),
          (SELECT l.name FROM locations l WHERE l.type = 'PROVINCE'
            AND (lower(l.title_en) = lower(s.slug) OR l.name = s.slug) LIMIT 1)
        ) AS name
      FROM slugs s
    )
    SELECT r.slug, r.kind, r.name,
      -- A province page spans its cities (as it always did). A city page does
      -- NOT absorb its children: before the tree existed only provinces had
      -- children, and widening this would silently change ~5 high-traffic
      -- pages. Curated cross-location inclusion is location_includes.
      (SELECT count(*) FROM residences res
         JOIN locations c ON c.id = res.location_id
         LEFT JOIN locations p ON p.id = c.parent_id AND p.type = 'PROVINCE'
        WHERE res.state = 'PUBLISHED' AND res.published = true
          AND ( lower(c.title_en) = lower(r.slug)
             OR c.name ILIKE '%' || r.slug || '%'
             OR lower(p.title_en) = lower(r.slug)
             OR p.name ILIKE '%' || r.slug || '%' )
      )::int AS count
    FROM resolved r
    ORDER BY r.slug
  `);
  return Object.fromEntries(
    rows.map((r) => [
      r.slug,
      {
        slug: r.slug,
        resolvedKind: r.kind as SlugEntry["resolvedKind"],
        resolvedName: r.name,
        residenceCount: Number(r.count),
      },
    ])
  );
}

function diff(before: Snapshot, after: Snapshot) {
  const problems: string[] = [];
  for (const slug of Object.keys(before)) {
    const b = before[slug];
    const a = after[slug];
    if (!a) {
      problems.push(`MISSING  ${slug} — resolved to ${b.resolvedKind} "${b.resolvedName}" before, gone now`);
      continue;
    }
    if (a.resolvedKind !== b.resolvedKind || a.resolvedName !== b.resolvedName) {
      problems.push(
        `REPOINTED ${slug} — was ${b.resolvedKind} "${b.resolvedName}", now ${a.resolvedKind} "${a.resolvedName}"`
      );
    }
    if (a.residenceCount !== b.residenceCount) {
      problems.push(`COUNT    ${slug} — was ${b.residenceCount} residences, now ${a.residenceCount}`);
    }
  }
  const added = Object.keys(after).filter((s) => !before[s]);
  return { problems, added };
}

async function main() {
  const merged = await tableExists("locations");
  console.log(`Schema detected: ${merged ? "locations (post-migration)" : "cities+provinces (pre-migration)"}`);

  const snap = merged ? await snapshotLocations() : await snapshotLegacy();
  const entries = Object.values(snap);
  console.log(`Slugs captured: ${entries.length}`);
  console.log(`  resolving to a city:     ${entries.filter((e) => e.resolvedKind === "city").length}`);
  console.log(`  resolving to a province: ${entries.filter((e) => e.resolvedKind === "province").length}`);
  console.log(`  unresolved:              ${entries.filter((e) => e.resolvedKind === "none").length}`);
  console.log(`  with 0 residences:       ${entries.filter((e) => e.residenceCount === 0).length}`);

  if (SAVE) {
    writeFileSync(SAVE, JSON.stringify(snap, null, 2), "utf8");
    console.log(`\nSnapshot written to ${SAVE}`);
  }

  if (COMPARE) {
    const before: Snapshot = JSON.parse(readFileSync(COMPARE, "utf8"));
    const { problems, added } = diff(before, snap);
    console.log(`\nCompared against ${COMPARE} (${Object.keys(before).length} slugs).`);
    if (added.length) console.log(`New slugs (not a regression): ${added.length}`);
    if (problems.length === 0) {
      console.log("\nPASS — every pre-migration slug resolves identically and returns the same count.");
    } else {
      console.log(`\nFAIL — ${problems.length} slug(s) changed meaning:\n`);
      problems.slice(0, 60).forEach((p) => console.log("  " + p));
      if (problems.length > 60) console.log(`  … and ${problems.length - 60} more`);
      process.exitCode = 1;
    }
  }

  if (!SAVE && !COMPARE) {
    console.log("\n(no --save or --compare given — nothing written)");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
