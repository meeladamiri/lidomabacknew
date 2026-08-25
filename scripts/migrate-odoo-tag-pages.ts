// Imports legacy Odoo `tag_url` (9,969 rows) into tag_pages.
//
// The first migration took only `x_url` from this table, to build the /tags/…
// 301 map in legacy_redirects. Everything else was dropped — including 9,967
// hand-written meta titles/descriptions and 22 hand-written page bodies, which
// getSearchPageData currently replaces with generated templates.
//
// The /tags/… URLs keep 301ing exactly as they do now (legacy_redirects is not
// touched). These rows supply the curated SEO for the page each 301 lands on,
// /search/<slug>?<tag>=1.
//
// `x_canonical` is deliberately NOT imported: it points either at the old
// /search/city/<fa>-<id> scheme (which itself 301s — a redirect hop) or back at
// the /tags/… URL (which 301s too). Both are legacy SEO mistakes; the canonical
// is generated fresh against the real destination instead.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-tag-pages.ts             # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-tag-pages.ts --commit    # writes

import { PrismaClient } from "@/generated/prisma/client";
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
  id: number;
  x_category_id: number | null;
  x_tag_id: number | null;
  x_url: string | null;
  website_meta_title: string | null;
  website_meta_description: string | null;
  website_meta_keywords: string | null;
  x_content: string | null;
  x_show_in_sitemap: boolean | null;
  x_active: boolean | null;
  residence_count: number | null;
}

// Odoo built each tag_url's meta from a template that interpolated the chosen
// city. For the 17 category-less rows ("تگ مادر") nothing was chosen, so the
// dropdown's own placeholder was interpolated instead and 15 of them read
// "اجاره ویلا استخردار در انتخاب کنید | …". Those titles are broken on the live
// site too. Importing them verbatim would ship the same nonsense as the title
// of a nationwide page, so they are dropped and the generated template — which
// simply omits the location — is used instead. An admin can write a real one
// in the tag-pages screen.
const PLACEHOLDER = "انتخاب کنید";

function clean(s: string | null): string | null {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t === "<p><br></p>" || t === "<p></p>") return null;
  if (t.includes(PLACEHOLDER)) return null;
  return t;
}

function normalizePath(raw: string | null): string | null {
  if (!raw) return null;
  let p = raw.trim();
  if (!p.startsWith("/")) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* malformed encoding — keep as-is, same as migrate-odoo-tag-urls.ts */
  }
  return p.replace(/\/+$/, "");
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const rows = await odoo.$queryRawUnsafe<TagUrlRow[]>(`
    SELECT id, x_category_id, x_tag_id, x_url,
           website_meta_title, website_meta_description, website_meta_keywords,
           x_content, x_show_in_sitemap, x_active, residence_count
    FROM tag_url
  `);
  console.log(`Fetched ${rows.length} tag_url rows.`);

  const [locations, tags] = await Promise.all([
    targetPrisma.location.findMany({ select: { id: true, odooId: true, name: true } }),
    targetPrisma.seoTag.findMany({ select: { id: true, odooId: true, key: true } }),
  ]);
  const locByOdoo = new Map(locations.filter((l) => l.odooId).map((l) => [l.odooId!, l]));
  const tagByOdoo = new Map(tags.filter((t) => t.odooId).map((t) => [t.odooId!, t]));

  // Odoo holds duplicate category rows for the same place (e.g. سمنان exists as
  // both 171 and 279). Both collapse onto one location, so only one id could be
  // stored in Location.odooId — the loser still owns tag_url rows. Recover it by
  // name so its curated meta is not dropped.
  const odooNames = await odoo.$queryRawUnsafe<{ id: number; name: string }[]>(
    `SELECT id, trim(name) AS name FROM product_public_category`
  );
  const odooNameById = new Map(odooNames.map((c) => [c.id, c.name]));
  const locByName = new Map<string, { id: number; name: string }>();
  for (const l of locations) if (!locByName.has(l.name)) locByName.set(l.name, l);

  const aliased = new Set<number>();
  const resolveLocation = (catId: number) => {
    const direct = locByOdoo.get(catId);
    if (direct) return direct;
    const name = odooNameById.get(catId);
    const byName = name ? locByName.get(name) : undefined;
    if (byName) aliased.add(catId);
    return byName;
  };

  interface Candidate {
    odooId: number;
    /** null = "تگ مادر", the nationwide tag page with no location. */
    locationId: number | null;
    tagId: number | null;
    legacyPath: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    metaKeywords: string | null;
    contentHtml: string | null;
    showInSitemap: boolean;
    isActive: boolean;
    residenceCount: number;
  }

  // (locationId, tagId) is unique — Odoo has ~430 duplicate pairs (several URLs
  // for one page). Keep the richest: active first, then hand-written content,
  // then the one Odoo counted the most listings for.
  const best = new Map<string, Candidate>();
  let noLocation = 0;
  let noTag = 0;

  const score = (c: Candidate) =>
    (c.isActive ? 1_000_000 : 0) + (c.contentHtml ? 100_000 : 0) + c.residenceCount;

  let motherTags = 0;
  for (const r of rows) {
    // A row with no category is a nationwide "تگ مادر" page, not a broken row.
    let locationId: number | null = null;
    if (r.x_category_id) {
      const loc = resolveLocation(r.x_category_id);
      if (!loc) {
        noLocation++;
        continue;
      }
      locationId = loc.id;
    } else {
      motherTags++;
    }

    let tagId: number | null = null;
    if (r.x_tag_id) {
      const tag = tagByOdoo.get(r.x_tag_id);
      if (!tag) {
        noTag++;
        continue;
      }
      tagId = tag.id;
    }

    const cand: Candidate = {
      odooId: r.id,
      locationId,
      tagId,
      legacyPath: normalizePath(r.x_url),
      metaTitle: clean(r.website_meta_title),
      metaDescription: clean(r.website_meta_description),
      metaKeywords: clean(r.website_meta_keywords),
      contentHtml: clean(r.x_content),
      showInSitemap: !!r.x_show_in_sitemap,
      isActive: r.x_active ?? true,
      residenceCount: r.residence_count ?? 0,
    };

    const k = `${cand.locationId ?? "null"}|${cand.tagId ?? "null"}`;
    const prev = best.get(k);
    if (!prev || score(cand) > score(prev)) best.set(k, cand);
  }

  const candidates = [...best.values()];
  // legacy_path carries a unique index; dedupe defensively.
  const seenPath = new Set<string>();
  for (const c of candidates) {
    if (!c.legacyPath) continue;
    if (seenPath.has(c.legacyPath)) c.legacyPath = null;
    else seenPath.add(c.legacyPath);
  }

  console.log(`\nUnique (location, tag) pages: ${candidates.length}`);
  console.log(`  active:              ${candidates.filter((c) => c.isActive).length}`);
  console.log(`  with meta title:     ${candidates.filter((c) => c.metaTitle).length}`);
  console.log(
    `  meta dropped as placeholder ("${PLACEHOLDER}"): ${
      rows.filter((r) => (r.website_meta_title ?? "").includes(PLACEHOLDER)).length
    } source rows`
  );
  console.log(`  with hand-written body: ${candidates.filter((c) => c.contentHtml).length}`);
  console.log(`  flagged for sitemap: ${candidates.filter((c) => c.showInSitemap).length}`);
  console.log(`  plain location page (no tag):  ${candidates.filter((c) => !c.locationId === false && !c.tagId).length}`);
  console.log(`  nationwide "تگ مادر" (no location): ${candidates.filter((c) => !c.locationId).length}  (from ${motherTags} rows)`);
  console.log(`\nSkipped: ${noLocation} rows whose category has no location, ${noTag} whose tag is unknown.`);
  if (aliased.size) {
    console.log(
      `Recovered ${aliased.size} duplicate Odoo categor${aliased.size === 1 ? "y" : "ies"} by name: ${[...aliased].join(", ")}`
    );
  }

  console.log("\nSample:");
  candidates
    .filter((c) => c.contentHtml)
    .slice(0, 3)
    .forEach((c) => {
      const loc = locations.find((l) => l.id === c.locationId);
      console.log(`  ${loc?.name} / tag#${c.tagId ?? "-"} :: ${c.metaTitle?.slice(0, 70)}`);
    });

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  // Rows already present before this run — only these need refreshing;
  // createMany writes the current values for everything else.
  const before = await targetPrisma.tagPage.findMany({
    where: { odooId: { not: null } },
    select: { id: true, odooId: true },
  });
  const preExisting = new Map(before.map((e) => [e.odooId!, e.id]));

  let created = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const res = await targetPrisma.tagPage.createMany({ data: chunk, skipDuplicates: true });
    created += res.count;
  }
  console.log(`\nCreated ${created} tag pages (${candidates.length - created} already existed).`);

  // Re-running refreshes content edited in Odoo since the last import. Done in
  // bounded batches: 9k sequential round-trips exhaust the Liara pool (P2024).
  const stale = candidates.filter((c) => preExisting.has(c.odooId));
  let refreshed = 0;
  const CONCURRENCY = 10;
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + CONCURRENCY).map((c) =>
        targetPrisma.tagPage.update({
          where: { id: preExisting.get(c.odooId)! },
          data: {
            metaTitle: c.metaTitle,
            metaDescription: c.metaDescription,
            metaKeywords: c.metaKeywords,
            contentHtml: c.contentHtml,
            showInSitemap: c.showInSitemap,
            isActive: c.isActive,
            residenceCount: c.residenceCount,
          },
        })
      )
    );
    refreshed += Math.min(CONCURRENCY, stale.length - i);
  }
  console.log(`Refreshed ${refreshed} pre-existing rows.`);
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
