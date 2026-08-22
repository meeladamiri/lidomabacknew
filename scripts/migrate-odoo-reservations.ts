// One-off migration: sale_order (legacy Odoo, restored into the sibling
// `odoo_legacy` database) -> reservations.
//
// Usage:
//   npx tsx scripts/migrate-odoo-reservations.ts               # dry run
//   npx tsx scripts/migrate-odoo-reservations.ts --commit        # writes
//
// Prerequisite: migrate-odoo-users.ts AND migrate-odoo-residences.ts must
// have already run — guest/host are resolved by phone against the
// already-migrated `users` table, residence via its `reference = "ODOO-<id>"`.
//
// Scope decision (confirmed with the project owner): out of 348,072 Odoo
// sale_order rows, only the 43,947 in state='sale' are migrated. Every one
// of those is fully paid (is_paid=true, fully_paid=true for all of them —
// verified before writing this), so they all map to our DONE state. The
// other 304k rows (74% cancel, 13% draft) are abandoned-cart/failed-payment
// noise, not real reservations — migrating them would just clutter the
// admin panel with records nobody can act on. Room-level booking detail
// (ReservationRoom) is NOT migrated in this pass — most residences are
// whole-place (SUIT) bookings; room-level linkage can be added later if
// boomgardi per-room history turns out to matter.

import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
// DATABASE_URL sets connection_limit=20 (see migrate-odoo-users.ts).
const CONCURRENCY = 15;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

interface OdooReservation {
  id: number;
  product_tmpl_id: number | null;
  start_date: Date;
  end_date: Date;
  total_days: number | null;
  guests_number: number | null;
  total_amount: number;
  host_portion: number | null;
  website_share: number | null;
  create_date: Date | null;
  write_date: Date | null;
  guest_phone: string | null;
  guest_mobile: string | null;
  host_phone: string | null;
  host_mobile: string | null;
}

async function fetchReservations(): Promise<OdooReservation[]> {
  return odoo.$queryRawUnsafe<OdooReservation[]>(`
    SELECT
      so.id,
      pp.product_tmpl_id,
      so.x_start_date AS start_date,
      so.x_end_date AS end_date,
      so.x_total_days AS total_days,
      so.x_guests_number AS guests_number,
      so.x_total_amount AS total_amount,
      so.x_actual_host_portion AS host_portion,
      so.x_website_share AS website_share,
      so.create_date,
      so.write_date,
      rp.phone AS guest_phone,
      rp.mobile AS guest_mobile,
      rh.phone AS host_phone,
      rh.mobile AS host_mobile
    FROM sale_order so
    LEFT JOIN res_partner rp ON rp.id = so.partner_id
    LEFT JOIN res_partner rh ON rh.id = so.x_host_id
    LEFT JOIN sale_order_line sol ON sol.order_id = so.id
    LEFT JOIN product_product pp ON pp.id = sol.product_id
    WHERE so.state = 'sale'
      AND so.x_start_date IS NOT NULL
      AND so.x_end_date IS NOT NULL
    GROUP BY so.id, pp.product_tmpl_id, rp.phone, rp.mobile, rh.phone, rh.mobile
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

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);
  console.log("Fetching confirmed (state=sale) reservations from odoo_legacy...");
  const rows = await fetchReservations();
  console.log(`Fetched ${rows.length} rows.`);

  const userIdByPhone = new Map<string, number | null>();
  async function resolveUserId(phone: string): Promise<number | null> {
    if (userIdByPhone.has(phone)) return userIdByPhone.get(phone)!;
    const user = await targetPrisma.user.findUnique({ where: { phone }, select: { id: true } });
    userIdByPhone.set(phone, user?.id ?? null);
    return user?.id ?? null;
  }

  const residenceIdByOdooTmplId = new Map<number, number | null>();
  async function resolveResidenceId(tmplId: number): Promise<number | null> {
    if (residenceIdByOdooTmplId.has(tmplId)) return residenceIdByOdooTmplId.get(tmplId)!;
    const residence = await targetPrisma.residence.findUnique({
      where: { reference: `ODOO-${tmplId}` },
      select: { id: true, hostId: true },
    });
    residenceIdByOdooTmplId.set(tmplId, residence?.id ?? null);
    return residence?.id ?? null;
  }

  let skippedNoResidence = 0;
  let skippedNoGuest = 0;
  let skippedNoHost = 0;
  let skippedBadDates = 0;
  let planned = 0;
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;

  const samples: string[] = [];

  await runConcurrent(rows, CONCURRENCY, async (r) => {
    if (!r.product_tmpl_id) {
      skippedNoResidence++;
      return;
    }
    const residenceId = await resolveResidenceId(r.product_tmpl_id);
    if (!residenceId) {
      skippedNoResidence++;
      return;
    }

    const guestPhone = normalizePhone(r.guest_mobile) ?? normalizePhone(r.guest_phone);
    const guestId = guestPhone ? await resolveUserId(guestPhone) : null;
    if (!guestId) {
      skippedNoGuest++;
      return;
    }

    const hostPhone = normalizePhone(r.host_mobile) ?? normalizePhone(r.host_phone);
    const hostId = hostPhone ? await resolveUserId(hostPhone) : null;
    if (!hostId) {
      skippedNoHost++;
      return;
    }

    const startDate = new Date(r.start_date);
    const endDate = new Date(r.end_date);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      skippedBadDates++;
      return;
    }

    planned++;
    if (samples.length < 5) {
      samples.push(JSON.stringify({ odooId: r.id, residenceId, guestId, hostId, startDate: r.start_date }));
    }

    if (!COMMIT) return;

    const reference = `RSV-ODOO-${r.id}`;
    try {
      const existing = await targetPrisma.reservation.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (existing) {
        alreadyExists++;
        return;
      }

      await targetPrisma.reservation.create({
        data: {
          reference,
          residenceId,
          guestId,
          hostId,
          startDate,
          endDate,
          daysCount: r.total_days ?? Math.max(1, Math.round((+endDate - +startDate) / 86400000)),
          guestsCount: r.guests_number ?? 1,
          state: "DONE",
          totalAmount: r.total_amount,
          paidAmount: r.total_amount,
          remainingAmount: 0,
          hostShare: r.host_portion,
          websiteShare: r.website_share,
          createdAt: r.create_date ?? startDate,
          updatedAt: r.write_date ?? startDate,
        },
      });
      created++;
    } catch (err) {
      failed++;
      console.error(`Failed odoo sale_order id=${r.id}:`, (err as Error).message);
    }
  });

  console.log(`\nPlanned: ${planned} / ${rows.length}`);
  console.log(`Skipped — residence not migrated: ${skippedNoResidence}`);
  console.log(`Skipped — guest has no migrated user: ${skippedNoGuest}`);
  console.log(`Skipped — host has no migrated user: ${skippedNoHost}`);
  console.log(`Skipped — invalid/inconsistent dates: ${skippedBadDates}`);
  console.log("\nSample of first 5:");
  samples.forEach((s) => console.log(s));

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
