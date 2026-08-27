// One-off migration: per-city/province SEO content from legacy Odoo's
// product_public_category (website_meta_title, website_meta_description,
// content [HTML guide text], x_content_title) -> the new SEO columns on
// cities/provinces. Feeds the /api/search/page-data endpoint that renders
// the search page's meta tags, "درباره"/guide block, and related searches.
//
// Matching mirrors fix-city-slugs-from-odoo.ts: (trimmed name, parent
// province name) — no Odoo id was stored during the original migration.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-city-seo.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-city-seo.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface OdooSeoRow {
  id: number;
  name: string;
  parent_id: number | null;
  meta_title: string | null;
  meta_description: string | null;
  content_title: string | null;
  content: string | null;
}

function clean(s: string | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

async function fetchType(type: "city" | "province"): Promise<OdooSeoRow[]> {
  return odoo.$queryRawUnsafe<OdooSeoRow[]>(`
    SELECT id, trim(name) AS name, parent_id,
           website_meta_title AS meta_title,
           website_meta_description AS meta_description,
           x_content_title AS content_title,
           content
    FROM product_public_category
    WHERE x_category_type = '${type}'
  `);
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const [provinces, cities] = await Promise.all([fetchType("province"), fetchType("city")]);
  console.log(`Fetched ${provinces.length} provinces, ${cities.length} cities.`);

  const provinceNameById = new Map<number, string>(provinces.map((p) => [p.id, p.name]));

  let provincesUpdated = 0;
  for (const p of provinces) {
    const data = {
      metaTitle: clean(p.meta_title),
      metaDescription: clean(p.meta_description),
      contentTitle: clean(p.content_title),
      contentHtml: clean(p.content),
    };
    if (!data.metaTitle && !data.metaDescription && !data.contentTitle && !data.contentHtml) continue;
    const row = await targetPrisma.province.findFirst({ where: { name: p.name } });
    if (!row) continue;
    if (COMMIT) await targetPrisma.province.update({ where: { id: row.id }, data });
    provincesUpdated++;
  }
  console.log(`Provinces ${COMMIT ? "updated" : "would update"}: ${provincesUpdated}`);

  let citiesUpdated = 0;
  let citiesNoMatch = 0;
  for (const c of cities) {
    const data = {
      metaTitle: clean(c.meta_title),
      metaDescription: clean(c.meta_description),
      contentTitle: clean(c.content_title),
      contentHtml: clean(c.content),
    };
    if (!data.metaTitle && !data.metaDescription && !data.contentTitle && !data.contentHtml) continue;
    const provinceName = c.parent_id ? provinceNameById.get(c.parent_id) : undefined;
    const row = await targetPrisma.city.findFirst({
      where: { name: c.name, ...(provinceName ? { province: { name: provinceName } } : {}) },
    });
    if (!row) {
      citiesNoMatch++;
      continue;
    }
    if (COMMIT) await targetPrisma.city.update({ where: { id: row.id }, data });
    citiesUpdated++;
  }
  console.log(`Cities ${COMMIT ? "updated" : "would update"}: ${citiesUpdated} (no target match: ${citiesNoMatch})`);

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
