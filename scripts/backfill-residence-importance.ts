// One-off backfill: "اهمیت اقامتگاه" — legacy Odoo product_template.x_sequence
// (the ops team's manual ranking weight, values up to 2e9; label in the Odoo
// form: "اهمیت اقامتگاه"/"ترتیب در نمایش") -> Residence.importance.
// Higher = ranked earlier in the default search ordering.
//
// Usage:
//   npx tsx --env-file=.env scripts/backfill-residence-importance.ts               # dry run
//   npx tsx --env-file=.env scripts/backfill-residence-importance.ts --commit        # writes

import { PrismaClient } from "@/generated/prisma/client";
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

  const rows = await odoo.$queryRawUnsafe<{ id: number; x_sequence: number }[]>(`
    SELECT id, x_sequence FROM product_template
    WHERE website_published = true AND x_sequence IS NOT NULL AND x_sequence <> 0
  `);
  console.log(`Templates with a nonzero importance: ${rows.length}`);

  let updated = 0;
  let noResidence = 0;
  for (const r of rows) {
    if (!COMMIT) continue;
    const res = await targetPrisma.residence.updateMany({
      where: { reference: `ODOO-${r.id}` },
      data: { importance: Math.trunc(r.x_sequence) },
    });
    if (res.count > 0) updated++;
    else noResidence++;
  }

  if (COMMIT) console.log(`Updated ${updated}, no matching residence: ${noResidence}.`);
  else console.log("Dry run complete — re-run with --commit to write.");
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
