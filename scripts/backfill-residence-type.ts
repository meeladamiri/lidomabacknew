// One-off backfill: "نوع ملک" — legacy Odoo product_template.x_display_type
// (suit | boomgardi | hotel | both) -> Residence.type.
//
// Why this exists: migrate-odoo-residences.ts inferred the type from a
// heuristic (`boomgardi_type ? BOOMGARDI : SUIT`) instead of reading the real
// field, so every hotel was filed as SUIT. This corrects the whole set from
// the authoritative column.
//
// Mapping:
//   suit      -> SUIT
//   boomgardi -> BOOMGARDI
//   hotel     -> HOTEL
//   both      -> SUIT   (a handful of rows; the old site's boomgardi tag
//                        domain matched x_display_type = 'boomgardi' exactly,
//                        so "both" already behaved as a suite there)
//   null      -> left untouched (all unpublished in the source)
//
// Usage:
//   npx tsx --env-file=.env scripts/backfill-residence-type.ts               # dry run
//   npx tsx --env-file=.env scripts/backfill-residence-type.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

const TYPE_MAP: Record<string, "SUIT" | "BOOMGARDI" | "HOTEL"> = {
  suit: "SUIT",
  both: "SUIT",
  boomgardi: "BOOMGARDI",
  hotel: "HOTEL",
};

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  const rows = await odoo.$queryRawUnsafe<{ id: number; x_display_type: string }[]>(`
    SELECT id, x_display_type FROM product_template
    WHERE website_published = true AND x_display_type IS NOT NULL
  `);
  console.log(`Published templates with a type: ${rows.length}`);

  // group ids per target type so this is a handful of updateMany calls
  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const target = TYPE_MAP[r.x_display_type];
    if (!target) continue;
    const list = byType.get(target) ?? [];
    list.push(`ODOO-${r.id}`);
    byType.set(target, list);
  }

  for (const [type, refs] of byType) {
    if (!COMMIT) {
      const n = await targetPrisma.residence.count({
        where: { reference: { in: refs }, type: { not: type as never } },
      });
      console.log(`${type}: ${refs.length} source rows, ${n} would change`);
      continue;
    }
    let changed = 0;
    for (let i = 0; i < refs.length; i += 1000) {
      const res = await targetPrisma.residence.updateMany({
        where: { reference: { in: refs.slice(i, i + 1000) } },
        data: { type: type as never },
      });
      changed += res.count;
    }
    console.log(`${type}: updated ${changed} residences`);
  }

  if (COMMIT) {
    const dist = await targetPrisma.residence.groupBy({ by: ["type"], _count: true });
    console.log("\nFinal distribution:", JSON.stringify(dist));
    console.log("Done.");
  } else {
    console.log("\nDry run complete — re-run with --commit to write.");
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
