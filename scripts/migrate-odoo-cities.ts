// One-off migration: product_public_category (legacy Odoo — a clean
// province/city tree, NOT the messy free-text product_template.x_city
// field) -> provinces/cities, then backfills `cityId` on the residences
// already migrated by migrate-odoo-residences.ts (matched via their
// `reference = "ODOO-<template id>"`, using product_template.x_main_category
// to resolve the residence's city).
//
// Usage:
//   npx tsx scripts/migrate-odoo-cities.ts               # dry run
//   npx tsx scripts/migrate-odoo-cities.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const CONCURRENCY = 12;

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
}

async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const provinces = await odoo.$queryRawUnsafe<OdooCategory[]>(`
    SELECT id, trim(name) AS name, parent_id
    FROM product_public_category
    WHERE x_category_type = 'province'
  `);
  const cities = await odoo.$queryRawUnsafe<OdooCategory[]>(`
    SELECT id, trim(name) AS name, parent_id
    FROM product_public_category
    WHERE x_category_type = 'city'
  `);
  console.log(`Fetched ${provinces.length} provinces, ${cities.length} cities.`);

  // odoo category id -> new Province/City id
  const provinceIdMap = new Map<number, number>();
  const cityIdMap = new Map<number, number>();

  console.log("\nSample provinces:", provinces.slice(0, 5).map((p) => p.name).join("، "));
  console.log("Sample cities:", cities.slice(0, 5).map((c) => c.name).join("، "));

  if (COMMIT) {
    for (const p of provinces) {
      const existing = await targetPrisma.province.findFirst({ where: { name: p.name } });
      const row = existing ?? (await targetPrisma.province.create({ data: { name: p.name } }));
      provinceIdMap.set(p.id, row.id);
    }
    console.log(`Provinces ready: ${provinceIdMap.size}`);

    await runConcurrent(cities, CONCURRENCY, async (c) => {
      const provinceId = c.parent_id ? provinceIdMap.get(c.parent_id) : undefined;
      const existing = await targetPrisma.city.findFirst({ where: { name: c.name, provinceId } });
      const row =
        existing ?? (await targetPrisma.city.create({ data: { name: c.name, provinceId } }));
      cityIdMap.set(c.id, row.id);
    });
    console.log(`Cities ready: ${cityIdMap.size}`);
  } else {
    // Dry run still needs the maps filled (from existing target rows, if any)
    // so the backfill count-preview below is meaningful.
    const existingProvinces = await targetPrisma.province.findMany();
    const existingCities = await targetPrisma.city.findMany();
    console.log(
      `(dry run) target currently has ${existingProvinces.length} provinces, ${existingCities.length} cities — these will be created/matched by name on --commit.`
    );
  }

  // ---------- Backfill residences.cityId ----------

  const templates = await odoo.$queryRawUnsafe<{ id: number; x_main_category: number }[]>(`
    SELECT pt.id, pt.x_main_category
    FROM product_template pt
    WHERE pt.website_published = true AND pt.x_main_category IS NOT NULL
  `);
  console.log(`\n${templates.length} published templates have x_main_category set.`);

  let matched = 0;
  let updated = 0;
  let noResidence = 0;
  let noCityMapping = 0;

  await runConcurrent(templates, CONCURRENCY, async (t) => {
    const cityId = cityIdMap.get(t.x_main_category);
    if (!cityId) {
      noCityMapping++;
      return;
    }
    matched++;
    if (!COMMIT) return;

    const reference = `ODOO-${t.id}`;
    const result = await targetPrisma.residence.updateMany({
      where: { reference },
      data: { cityId },
    });
    if (result.count > 0) updated++;
    else noResidence++;
  });

  console.log(`\nTemplates whose category resolved to a migrated city: ${matched}`);
  console.log(`Templates whose category did NOT map to a city row (region/neighborhood/etc): ${noCityMapping}`);
  if (COMMIT) {
    console.log(`Residences updated with cityId: ${updated}`);
    console.log(`Templates with no matching residence row (not migrated, e.g. skipped for no host): ${noResidence}`);
  }

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
  } else {
    console.log("\nDone.");
  }
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
