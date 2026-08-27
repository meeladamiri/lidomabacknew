// One-off migration: x_special_dates + x_fast_dates (legacy Odoo) ->
// calendar_days.
//
// Usage:
//   npx tsx scripts/migrate-odoo-calendar.ts               # dry run
//   npx tsx scripts/migrate-odoo-calendar.ts --commit        # writes
//
// Prerequisite: migrate-odoo-residences.ts must have already run —
// residence matched via `reference = "ODOO-<template id>"`.
//
// Scope decisions:
//   - `x_hotel_date_price` (the table this was originally expected to come
//     from) turned out to be completely empty (0 rows) — the real sources
//     are `x_special_dates` (per-date price override) and `x_fast_dates`
//     (per-date instant-book flag).
//   - Only dates from today onward, capped 2 years out, are migrated
//     (94% of x_special_dates is past-dated — a calendar entry for a date
//     that already happened has no value for a live booking system; the
//     table also has some junk dates centuries out).
//   - Room-level entries (x_room_id set) are skipped — only ~75 rows out
//     of ~10,500 relevant ones, and migrate-odoo-residences.ts never
//     recorded an Odoo room id -> new Room id mapping to resolve them
//     against, so residence-level (roomId = null) is the only really
//     resolvable target.
//   - `isBlocked` is NOT set from historical reservation data — every
//     migrated reservation is for a past date range (guests already
//     stayed), so it can't inform *future* availability.

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const CONCURRENCY = 15;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface SpecialDateRow {
  product_tmpl_id: number;
  date: Date;
  price: number;
}
interface FastDateRow {
  product_tmpl_id: number;
  date: Date;
}

async function fetchSpecialDates(): Promise<SpecialDateRow[]> {
  return odoo.$queryRawUnsafe<SpecialDateRow[]>(`
    SELECT pp.product_tmpl_id, sd.x_date AS date, sd.x_price AS price
    FROM x_special_dates sd
    JOIN product_product pp ON pp.id = sd.x_product_id
    WHERE sd.x_room_id IS NULL
      AND sd.x_date >= CURRENT_DATE
      AND sd.x_date < CURRENT_DATE + interval '2 years'
      AND sd.x_price IS NOT NULL
  `);
}

async function fetchFastDates(): Promise<FastDateRow[]> {
  return odoo.$queryRawUnsafe<FastDateRow[]>(`
    SELECT pp.product_tmpl_id, fd.x_date AS date
    FROM x_fast_dates fd
    JOIN product_product pp ON pp.id = fd.x_product_id
    WHERE fd.x_room_id IS NULL
      AND fd.x_date >= CURRENT_DATE
      AND fd.x_date < CURRENT_DATE + interval '2 years'
  `);
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

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);
  console.log("Fetching special/fast dates from odoo_legacy...");
  const [specialDates, fastDates] = await Promise.all([fetchSpecialDates(), fetchFastDates()]);
  console.log(`Fetched ${specialDates.length} special-price dates, ${fastDates.length} fast-book dates.`);

  // Merge into one row per (template, date).
  const merged = new Map<string, { tmplId: number; date: Date; specialPrice?: number; isFast?: boolean }>();
  for (const r of specialDates) {
    const key = `${r.product_tmpl_id}:${dateKey(r.date)}`;
    merged.set(key, { ...(merged.get(key) ?? { tmplId: r.product_tmpl_id, date: r.date }), specialPrice: r.price });
  }
  for (const r of fastDates) {
    const key = `${r.product_tmpl_id}:${dateKey(r.date)}`;
    merged.set(key, { ...(merged.get(key) ?? { tmplId: r.product_tmpl_id, date: r.date }), isFast: true });
  }
  const rows = [...merged.values()];
  console.log(`Merged into ${rows.length} calendar-day entries.`);

  const residenceIdByTmplId = new Map<number, number | null>();
  async function resolveResidenceId(tmplId: number): Promise<number | null> {
    if (residenceIdByTmplId.has(tmplId)) return residenceIdByTmplId.get(tmplId)!;
    const residence = await targetPrisma.residence.findUnique({
      where: { reference: `ODOO-${tmplId}` },
      select: { id: true },
    });
    residenceIdByTmplId.set(tmplId, residence?.id ?? null);
    return residence?.id ?? null;
  }

  let planned = 0;
  let skippedNoResidence = 0;
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;

  await runConcurrent(rows, CONCURRENCY, async (r) => {
    const residenceId = await resolveResidenceId(r.tmplId);
    if (!residenceId) {
      skippedNoResidence++;
      return;
    }
    planned++;
    if (!COMMIT) return;

    try {
      // findUnique on the compound key rejects `roomId: null` outright
      // (P2009-adjacent "Argument roomId must not be null") even though the
      // column is nullable — findFirst has no such restriction.
      const existing = await targetPrisma.calendarDay.findFirst({
        where: { residenceId, roomId: null, date: r.date },
        select: { id: true },
      });
      if (existing) {
        alreadyExists++;
        return;
      }
      await targetPrisma.calendarDay.create({
        data: {
          residenceId,
          date: r.date,
          specialPrice: r.specialPrice,
          isFast: r.isFast ?? undefined,
        },
      });
      created++;
    } catch (err) {
      failed++;
      console.error(`Failed template=${r.tmplId} date=${dateKey(r.date)}:`, (err as Error).message);
    }
  });

  console.log(`\nPlanned: ${planned} / ${rows.length}`);
  console.log(`Skipped — residence not migrated: ${skippedNoResidence}`);

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  console.log(`\nDone. Created ${created}, already existed ${alreadyExists}, failed ${failed}.`);
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
