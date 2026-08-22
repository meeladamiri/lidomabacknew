// One-off fix: replaces `titleEn` on cities (and fills it on provinces)
// with the REAL slugs from legacy Odoo's `product_public_category.x_title_en`
// — the column the team hand-curated in the Odoo admin panel and that every
// old indexed URL (e.g. /search/tehran, /search/yazd) is built on.
//
// This supersedes scripts/backfill-city-slugs.ts, whose transliterated
// slugs (yazd -> "izd", esfahan -> "asfhan", qeshm -> "ghshm", ...) do NOT
// match the SEO-indexed originals and must be overwritten. Keep this script;
// treat backfill-city-slugs.ts as retired.
//
// Matching mirrors migrate-odoo-cities.ts: cities were created by
// (name, provinceId) with the province resolved by name — no Odoo id was
// stored — so the same (trimmed name, parent province name) key is used here.
//
// Usage:
//   npx tsx scripts/fix-city-slugs-from-odoo.ts               # dry run
//   npx tsx scripts/fix-city-slugs-from-odoo.ts --commit        # writes

import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface OdooCategory {
  id: number;
  name: string;
  parent_id: number | null;
  x_title_en: string | null;
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const provinces = await odoo.$queryRawUnsafe<OdooCategory[]>(`
    SELECT id, trim(name) AS name, parent_id, trim(x_title_en) AS x_title_en
    FROM product_public_category
    WHERE x_category_type = 'province'
  `);
  const cities = await odoo.$queryRawUnsafe<OdooCategory[]>(`
    SELECT id, trim(name) AS name, parent_id, trim(x_title_en) AS x_title_en
    FROM product_public_category
    WHERE x_category_type = 'city'
  `);
  console.log(`Fetched ${provinces.length} provinces, ${cities.length} cities from odoo_legacy.`);

  // ---------- Provinces ----------
  const provinceNameById = new Map<number, string>();
  let provincesUpdated = 0;
  let provincesNoMatch = 0;

  for (const p of provinces) {
    provinceNameById.set(p.id, p.name);
    if (!p.x_title_en) continue;
    const row = await targetPrisma.province.findFirst({ where: { name: p.name } });
    if (!row) {
      provincesNoMatch++;
      continue;
    }
    if (COMMIT) {
      await targetPrisma.province.update({ where: { id: row.id }, data: { titleEn: p.x_title_en } });
    }
    provincesUpdated++;
  }
  console.log(`Provinces ${COMMIT ? "updated" : "would update"}: ${provincesUpdated} (no target match: ${provincesNoMatch})`);

  // ---------- Cities ----------
  let citiesUpdated = 0;
  let citiesNoMatch = 0;
  let citiesNoSlug = 0;
  const samples: string[] = [];

  for (const c of cities) {
    if (!c.x_title_en) {
      citiesNoSlug++;
      continue;
    }
    const provinceName = c.parent_id ? provinceNameById.get(c.parent_id) : undefined;
    const row = await targetPrisma.city.findFirst({
      where: { name: c.name, ...(provinceName ? { province: { name: provinceName } } : {}) },
      include: { province: { select: { name: true } } },
    });
    if (!row) {
      citiesNoMatch++;
      continue;
    }
    if (samples.length < 12 && row.titleEn !== c.x_title_en) {
      samples.push(`${c.name}: ${row.titleEn ?? "(null)"} -> ${c.x_title_en}`);
    }
    if (COMMIT) {
      await targetPrisma.city.update({ where: { id: row.id }, data: { titleEn: c.x_title_en } });
    }
    citiesUpdated++;
  }

  console.log(`Cities ${COMMIT ? "updated" : "would update"}: ${citiesUpdated} (no target match: ${citiesNoMatch}, no slug in Odoo: ${citiesNoSlug})`);
  console.log("\nSample changes:");
  samples.forEach((s) => console.log("  " + s));

  if (!COMMIT) console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
  else console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await odoo.$disconnect();
    await targetPrisma.$disconnect();
  });
