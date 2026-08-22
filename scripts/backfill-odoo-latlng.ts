// One-off backfill: sets latitude/longitude on residences already created by
// migrate-odoo-residences.ts before that script captured x_lattitude/
// x_longitude (a migration bug found during manual QA — coordinates were
// silently dropped, breaking the map on residence pages). Matched via
// `reference = "ODOO-<template id>"`, same as the other backfill scripts.
//
// Usage:
//   npx tsx scripts/backfill-odoo-latlng.ts               # dry run
//   npx tsx scripts/backfill-odoo-latlng.ts --commit        # writes

import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const CONCURRENCY = 15;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

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

  const rows = await odoo.$queryRawUnsafe<{ id: number; latitude: number; longitude: number }[]>(`
    SELECT id, x_lattitude::float AS latitude, x_longitude::float AS longitude
    FROM product_template
    WHERE website_published = true
      AND NULLIF(trim(x_lattitude), '') IS NOT NULL
      AND NULLIF(trim(x_longitude), '') IS NOT NULL
  `);
  console.log(`Fetched ${rows.length} templates with coordinates.`);

  let updated = 0;
  let noResidence = 0;
  let alreadySet = 0;

  await runConcurrent(rows, CONCURRENCY, async (r) => {
    const reference = `ODOO-${r.id}`;
    const existing = await targetPrisma.residence.findUnique({
      where: { reference },
      select: { id: true, latitude: true, longitude: true },
    });
    if (!existing) {
      noResidence++;
      return;
    }
    if (existing.latitude != null && existing.longitude != null) {
      alreadySet++;
      return;
    }
    if (!COMMIT) return;
    await targetPrisma.residence.update({
      where: { id: existing.id },
      data: { latitude: r.latitude, longitude: r.longitude },
    });
    updated++;
  });

  console.log(`\nResidences with no coordinates yet, matched, ${COMMIT ? "updated" : "would update"}: ${COMMIT ? updated : rows.length - noResidence - alreadySet}`);
  console.log(`Already had coordinates set: ${alreadySet}`);
  console.log(`No matching migrated residence: ${noResidence}`);

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
