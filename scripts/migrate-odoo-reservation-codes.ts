// One-off migration: give migrated reservations the code the business knows.
//
//   npx tsx scripts/migrate-odoo-reservation-codes.ts            # dry run
//   npx tsx scripts/migrate-odoo-reservation-codes.ts --commit   # writes
//
// The earlier migration built references as `RSV-ODOO-<sale_order.id>`, using
// Odoo's internal row id. The code staff and hosts actually use is
// `sale_order.name` — and it is a different number:
//
//   odoo id 370121  →  SO369973
//   odoo id 370108  →  SO369960
//
// So searching the panel for the code on someone's invoice found nothing, and
// reading our code back to a host meant nothing to them. This rewrites
// `reference` to the Odoo name for the 29,643 migrated bookings.
//
// What is deliberately NOT rewritten: text already written into notification
// bodies, deposit descriptions and activity entries. Those are records of what
// was said at the time, and editing them would be forging history to make it
// tidy. Anything generated from now on carries the new code.

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  const names = await odoo.$queryRawUnsafe<{ id: number; name: string | null }[]>(
    `SELECT id, name FROM sale_order WHERE name IS NOT NULL`
  );
  const nameByOdooId = new Map(names.map((r) => [r.id, r.name!]));
  console.log(`Odoo: ${nameByOdooId.size} order names.`);

  const ours = await targetPrisma.reservation.findMany({
    where: { reference: { startsWith: "RSV-ODOO-" } },
    select: { id: true, reference: true },
  });
  console.log(`Ours: ${ours.length} migrated reservations.`);

  const planned: { id: number; from: string; to: string }[] = [];
  const seen = new Map<string, number>();
  let missing = 0;
  let collisions = 0;

  for (const r of ours) {
    const odooId = Number(r.reference.replace("RSV-ODOO-", ""));
    const name = nameByOdooId.get(odooId);

    if (!name) {
      missing++;
      continue;
    }

    // Two bookings cannot share a reference — the column is unique, and a
    // duplicate would fail the write halfway through. Caught here instead.
    const already = seen.get(name);
    if (already) {
      collisions++;
      console.warn(`  collision: ${name} wanted by reservation ${already} and ${r.id}`);
      continue;
    }

    seen.set(name, r.id);
    planned.push({ id: r.id, from: r.reference, to: name });
  }

  // A name that already belongs to some other row would also break the write.
  const taken = await targetPrisma.reservation.findMany({
    where: { reference: { in: planned.map((p) => p.to) } },
    select: { id: true, reference: true },
  });
  const conflicting = taken.filter((t) => !planned.some((p) => p.id === t.id && p.to === t.reference));

  console.log(
    [
      `Planned renames:    ${planned.length}`,
      `No Odoo name:       ${missing} (left as-is)`,
      `Duplicate names:    ${collisions} (left as-is)`,
      `Existing conflicts: ${conflicting.length}`,
    ].join("\n")
  );

  console.log("\nSample:");
  planned.slice(0, 5).forEach((p) => console.log(`  ${p.from}  →  ${p.to}`));

  if (conflicting.length > 0) {
    console.error("\nRefusing: some target references are already in use by other rows.");
    conflicting.slice(0, 10).forEach((c) => console.error(`  ${c.reference} (reservation ${c.id})`));
    await odoo.$disconnect();
    return;
  }

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit.");
    await odoo.$disconnect();
    return;
  }

  const CHUNK = 500;
  for (let i = 0; i < planned.length; i += CHUNK) {
    const slice = planned.slice(i, i + CHUNK);
    await targetPrisma.$transaction(
      slice.map((p) =>
        targetPrisma.reservation.update({ where: { id: p.id }, data: { reference: p.to } })
      )
    );
    console.log(`  ${Math.min(i + CHUNK, planned.length)}/${planned.length}`);
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
