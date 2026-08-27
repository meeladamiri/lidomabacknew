// One-off migration: legacy Odoo `tag_url` (the SEO tag-page URL registry,
// e.g. "/tags/villa/اجاره-ویلا-در-آبادان") -> `legacy_redirects`, with the
// 301 target computed the same way the old production site does:
//
//   /search/<city x_title_en>?<website_tags.x_title>=1
//
// (verified against live lidomatrip.com: /tags/villa/اجاره-ویلا-در-آبادان
// 301s to /search/abadan?villa=1; slugs it can't resolve go to /search).
//
// Notes:
//   - `x_tag_id` joins website_tags; its `x_title` IS the query-param key the
//     search page already understands (villa/pool/jacuzzi/... — the same keys
//     production renders in the search-page footer nav). Rows with a null
//     tag id (e.g. the "suite" URLs) target the bare city page.
//   - `x_category_id` joins product_public_category; its `x_title_en` is the
//     hand-curated city slug (see fix-city-slugs-from-odoo.ts).
//   - Inactive rows (x_active = false) are included too — an old indexed URL
//     should still land somewhere sensible, matching 301-to-search behavior.
//   - Paths are stored percent-DECODED; the lookup endpoint decodes incoming
//     paths before matching.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-tag-urls.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-tag-urls.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const BATCH = 500;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface TagUrlRow {
  x_url: string;
  tag_key: string | null; // website_tags.x_title
  city_slug: string | null; // product_public_category.x_title_en
}

function normalizePath(raw: string): string | null {
  let p = raw.trim();
  if (!p.startsWith("/")) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is if malformed encoding */
  }
  return p.replace(/\/+$/, "");
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const rows = await odoo.$queryRawUnsafe<TagUrlRow[]>(`
    SELECT tu.x_url,
           trim(wt.x_title)        AS tag_key,
           trim(ppc.x_title_en)    AS city_slug
    FROM tag_url tu
    LEFT JOIN website_tags wt ON wt.id = tu.x_tag_id
    LEFT JOIN product_public_category ppc ON ppc.id = tu.x_category_id
    WHERE tu.x_url IS NOT NULL
  `);
  console.log(`Fetched ${rows.length} tag_url rows from odoo_legacy.`);

  // path -> target (last write wins for duplicate paths; they're identical in practice)
  const redirects = new Map<string, string>();
  let noCitySlug = 0;

  for (const r of rows) {
    const path = normalizePath(r.x_url);
    if (!path) continue;

    let target: string;
    if (r.city_slug) {
      target = `/search/${r.city_slug}${r.tag_key ? `?${r.tag_key}=1` : ""}`;
    } else {
      noCitySlug++;
      target = r.tag_key ? `/search?${r.tag_key}=1` : "/search";
    }
    redirects.set(path, target);
  }
  console.log(`Unique redirect paths: ${redirects.size} (rows without a resolvable city slug: ${noCitySlug})`);

  const sample = [...redirects.entries()].slice(0, 6);
  console.log("\nSample:");
  sample.forEach(([p, t]) => console.log(`  ${p}  ->  ${t}`));

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  // Idempotent bulk upsert via createMany+skipDuplicates, then fix any
  // path whose target changed since a previous run.
  const entries = [...redirects.entries()].map(([path, target]) => ({ path, target }));
  let created = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const res = await targetPrisma.legacyRedirect.createMany({ data: chunk, skipDuplicates: true });
    created += res.count;
  }
  console.log(`\nCreated ${created} new redirects (${entries.length - created} already existed).`);

  const existing = await targetPrisma.legacyRedirect.findMany({ select: { id: true, path: true, target: true } });
  let retargeted = 0;
  for (const row of existing) {
    const want = redirects.get(row.path);
    if (want && want !== row.target) {
      await targetPrisma.legacyRedirect.update({ where: { id: row.id }, data: { target: want } });
      retargeted++;
    }
  }
  console.log(`Retargeted ${retargeted} existing rows whose computed target changed.`);
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
