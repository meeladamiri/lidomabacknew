// One-off migration: Odoo's settlement history -> clear_remainder + host_deposits.
//
//   npx tsx scripts/migrate-odoo-deposits.ts            # dry run
//   npx tsx scripts/migrate-odoo-deposits.ts --commit   # writes
//
// Why this is not optional. The deposit panel opens on «مانده واریز», and
// without this every one of the 29,000 migrated bookings shows its full host
// share still owing — bookings Odoo paid out years ago. A finance team reading
// that list would pay them a second time. The panel is only as true as this
// number, so the number has to come across with it.
//
// Two Odoo tables carry it:
//
//   x_clear_remainder_info  a log of what the remainder was set to, one row
//                           per change. The newest row per order is today's
//                           value; the first says "مقدار اولیه مانده واریز"
//                           and equals the host's portion.
//   wallet_transaction      the payments themselves (37,044 orders have one),
//                           with the amount and when it was sent.
//
// Wallets are deliberately untouched. The new system's wallet only ever held
// income for bookings completed here; writing these payments into it would
// invent balances that never existed.

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface RemainderRow {
  order_id: number;
  amount: number;
}

interface PaymentRow {
  order_id: number;
  amount: number;
  created: Date;
  reference: string | null;
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  // The newest remainder row per order. DISTINCT ON is the cheap way to say
  // "latest per group" in Postgres.
  const remainders = await odoo.$queryRawUnsafe<RemainderRow[]>(`
    SELECT DISTINCT ON (i.x_order) i.x_order AS order_id, i.x_amount AS amount
    FROM x_clear_remainder_info i
    WHERE i.x_order IS NOT NULL
    ORDER BY i.x_order, i.id DESC
  `);

  const payments = await odoo.$queryRawUnsafe<PaymentRow[]>(`
    SELECT wt.sale_order_id AS order_id,
           wt.amount::float8 AS amount,
           wt.create_date AS created,
           wt.reference
    FROM wallet_transaction wt
    WHERE wt.txn_type = 'debit' AND wt.sale_order_id IS NOT NULL AND wt.amount > 0
  `);

  console.log(`Odoo: ${remainders.length} remainder rows, ${payments.length} payments.`);

  // Our reservations keyed by the Odoo order id they came from.
  const ours = await targetPrisma.reservation.findMany({
    where: { reference: { startsWith: "RSV-ODOO-" } },
    select: { id: true, reference: true, hostId: true, hostShare: true },
  });

  const byOdooId = new Map<number, (typeof ours)[number]>();
  for (const r of ours) {
    const odooId = Number(r.reference.replace("RSV-ODOO-", ""));
    if (Number.isFinite(odooId)) byOdooId.set(odooId, r);
  }
  console.log(`Ours: ${byOdooId.size} migrated reservations.`);

  const paymentsByOrder = new Map<number, PaymentRow[]>();
  for (const p of payments) {
    const list = paymentsByOrder.get(p.order_id);
    if (list) list.push(p);
    else paymentsByOrder.set(p.order_id, [p]);
  }

  const remainderByOrder = new Map<number, number>();
  for (const r of remainders) remainderByOrder.set(r.order_id, Math.max(Number(r.amount) || 0, 0));

  let matched = 0;
  let fullySettled = 0;
  let partiallySettled = 0;
  let depositRows = 0;
  let skipped = 0;

  const updates: { id: number; clearRemainder: number; settledAmount: number }[] = [];
  const deposits: {
    hostId: number;
    reservationId: number;
    amount: number;
    depositedAt: Date;
    txnId: string | null;
  }[] = [];

  // Driven by our own reservations, not by either Odoo table. Only 8,096 of
  // the 43,939 confirmed orders have a remainder-log row, while 34,866 have a
  // payment — so iterating the log alone would have left most bookings looking
  // unpaid, which is the exact mistake this script exists to prevent.
  for (const [odooId, target] of byOdooId) {
    const hostShare = target.hostShare ?? 0;
    const rows = paymentsByOrder.get(odooId) ?? [];
    const paid = rows.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const logged = remainderByOrder.get(odooId);

    // The log wins where it exists: it is the figure Odoo's own panel showed
    // and therefore the one staff acted on. Everywhere else the remainder is
    // what the payments did not cover.
    const remainder =
      logged != null ? logged : Math.max(hostShare - paid, 0);

    const settled = Math.max(hostShare - remainder, 0);

    if (rows.length === 0 && logged == null) {
      // Nothing recorded either way — leave it exactly as the earlier
      // migration set it rather than asserting it was never paid.
      skipped++;
      continue;
    }

    matched++;
    if (remainder === 0 && hostShare > 0) fullySettled++;
    else if (settled > 0) partiallySettled++;

    updates.push({ id: target.id, clearRemainder: remainder, settledAmount: settled });

    for (const p of rows) {
      deposits.push({
        hostId: target.hostId,
        reservationId: target.id,
        amount: Number(p.amount) || 0,
        depositedAt: p.created ?? new Date(),
        txnId: p.reference ?? null,
      });
      depositRows++;
    }
  }

  console.log(
    [
      `Matched:            ${matched}`,
      `  fully settled:    ${fullySettled}`,
      `  partly settled:   ${partiallySettled}`,
      `Payment rows:       ${depositRows}`,
      `No record either way: ${skipped} (left as-is)`,
    ].join("\n")
  );

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit.");
    await odoo.$disconnect();
    return;
  }

  // Chunked: 29,000 statements in one transaction is a lock held for minutes.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await targetPrisma.$transaction(
      slice.map((u) =>
        targetPrisma.reservation.update({
          where: { id: u.id },
          data: { clearRemainder: u.clearRemainder, settledAmount: u.settledAmount },
        })
      )
    );
    console.log(`  reservations ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  for (let i = 0; i < deposits.length; i += CHUNK) {
    await targetPrisma.hostDeposit.createMany({
      data: deposits.slice(i, i + CHUNK).map((d) => ({
        ...d,
        kind: "REMAINDER" as const,
        description: "واریز ثبت‌شده در سیستم قبلی",
        payerName: "سیستم قبلی",
      })),
      skipDuplicates: true,
    });
    console.log(`  deposits ${Math.min(i + CHUNK, deposits.length)}/${deposits.length}`);
  }

  console.log("Done.");
  await odoo.$disconnect();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await targetPrisma.$disconnect();
  });
