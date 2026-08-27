// One-off migration: legacy Odoo `user_review` (14,285 published reviews
// with the same six sub-scores the new Review model has, plus host answers)
// -> reviews.
//
// Resolution:
//   - reservation: x_order_id -> our reservations' reference "RSV-ODOO-<id>"
//     (Review is 1:1 with Reservation, so only reviews with a migrated
//     reservation can be stored; ~1.3k published reviews have no order id
//     and are skipped — they predate the order linkage).
//   - residence/guest are taken FROM the resolved reservation (guaranteed
//     consistent), not re-resolved.
//   - Only `state='pub' AND active` (what the old site actually displayed).
//   - Multiple reviews per order (352 cases): the newest wins.
//   - averageRating: stored Odoo overall `rating`; residence aggregates are
//     recomputed at the end.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-reviews.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-reviews.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const CONCURRENCY = 10;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface ReviewRow {
  id: number;
  x_order_id: number;
  rating: number | null;
  rating_cleaning: number | null;
  rating_loc: number | null;
  rating_quality: number | null;
  rating_integrity: number | null;
  rating_greeting: number | null;
  rating_delivery: number | null;
  msg: string | null;
  host_answer: string | null;
  create_date: Date;
}

async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  async function worker() {
    while (i < items.length) await fn(items[i++]);
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

const clamp = (n: number | null | undefined, fallback: number) =>
  Math.min(5, Math.max(1, Math.round(n ?? fallback) || fallback));

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  const rows = await odoo.$queryRawUnsafe<ReviewRow[]>(`
    SELECT DISTINCT ON (x_order_id)
           id, x_order_id, rating, rating_cleaning, rating_loc, rating_quality,
           rating_integrity, rating_greeting, rating_delivery, msg, host_answer, create_date
    FROM user_review
    WHERE state = 'pub' AND active = true AND x_order_id IS NOT NULL
    ORDER BY x_order_id, create_date DESC
  `);
  console.log(`Fetched ${rows.length} published reviews with an order id.`);

  // reservation reference -> {id, residenceId, guestId}
  const reservations = await targetPrisma.reservation.findMany({
    where: { reference: { startsWith: "RSV-ODOO-" } },
    select: { id: true, reference: true, residenceId: true, guestId: true },
  });
  const byOrder = new Map(reservations.map((r) => [Number(r.reference.slice(9)), r]));
  console.log(`${byOrder.size} migrated reservations to match against.`);

  let planned = 0;
  let noReservation = 0;
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;
  const touchedResidences = new Set<number>();

  await runConcurrent(rows, CONCURRENCY, async (r) => {
    const resv = byOrder.get(r.x_order_id);
    if (!resv) {
      noReservation++;
      return;
    }
    planned++;
    if (!COMMIT) return;
    try {
      const existing = await targetPrisma.review.findUnique({
        where: { reservationId: resv.id },
        select: { id: true },
      });
      if (existing) {
        alreadyExists++;
        return;
      }
      const overall = clamp(r.rating, 5);
      await targetPrisma.review.create({
        data: {
          reservationId: resv.id,
          residenceId: resv.residenceId,
          guestId: resv.guestId,
          cleaning: clamp(r.rating_cleaning, overall),
          location: clamp(r.rating_loc, overall),
          quality: clamp(r.rating_quality, overall),
          integrity: clamp(r.rating_integrity, overall),
          greeting: clamp(r.rating_greeting, overall),
          delivery: clamp(r.rating_delivery, overall),
          averageRating: r.rating ?? overall,
          comment: r.msg?.trim() || "",
          hostAnswer: r.host_answer?.trim() || null,
          createdAt: r.create_date,
        },
      });
      touchedResidences.add(resv.residenceId);
      created++;
    } catch (err) {
      failed++;
      if (failed <= 5) console.error(`review ${r.id}:`, (err as Error).message);
    }
  });

  console.log(`Planned ${planned}, no migrated reservation: ${noReservation}`);
  if (!COMMIT) {
    console.log("\nDry run complete — re-run with --commit to write.");
    return;
  }
  console.log(`Created ${created}, already existed ${alreadyExists}, failed ${failed}.`);

  // recompute residence aggregates for touched residences
  console.log(`Recomputing aggregates for ${touchedResidences.size} residences...`);
  for (const residenceId of touchedResidences) {
    const agg = await targetPrisma.review.aggregate({
      where: { residenceId },
      _avg: { averageRating: true },
      _count: true,
    });
    await targetPrisma.residence.update({
      where: { id: residenceId },
      data: { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count },
    });
  }
  console.log("\nDone.");
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
