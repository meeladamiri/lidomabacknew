// Fills in the location tree from legacy Odoo `product_public_category`:
//
//   1. Backfills `odooId` onto the cities/provinces that already exist (they
//      were originally matched by name only — see check-odoo-location-match.ts).
//   2. Creates the four levels that were never migrated: country, region,
//      village, neighborhood.
//   3. Wires the breadcrumb tree (parentId) and SEO canonicals (canonicalId).
//   4. Fills `location_includes` — "شهرهای زیرمجموعه", the rows that make a
//      search for شمال also return مازندران/گیلان/گلستان listings.
//   5. Fills all three `location_seo` sets: default, بوم‌گردی, هتل.
//
// Idempotent: everything keys off odooId, so re-running only updates.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-locations.ts             # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-locations.ts --commit    # writes

import { PrismaClient, type LocationType, type ResidenceType } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";
import { ODOO_ID_IS_PROVINCE_ROW, ODOO_IDS_TO_SKIP, ODOO_ROOT_ID } from "./odooLocationOverrides";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface OdooCat {
  id: number;
  name: string;
  parent_id: number | null;
  x_title_en: string | null;
  x_category_type: string | null;
  x_canonical_category: number | null;
  website_published: boolean | null;
  x_asli: boolean | null;
  x_homepage: boolean | null;
  x_homepage_boomgardi: boolean | null;
  x_popular_index: number | null;
  x_shomal_sequence: number | null;
  x_boomgardi_home_index: number | null;
  x_tags: string | null;
  sequence: number | null;
  // default SEO set
  website_meta_title: string | null;
  website_meta_description: string | null;
  website_meta_keywords: string | null;
  x_content_title: string | null;
  content: string | null;
  x_phone: string | null;
  x_show_phone_numbers: boolean | null;
  x_show_phone_numbers_from: number | null;
  x_show_phone_numbers_to: number | null;
  // بوم‌گردی set
  x_boomgardi_title: string | null;
  x_boomgardi_meta_title: string | null;
  x_boomgardi_meta_desc: string | null;
  x_boomgardi_meta_keywords: string | null;
  x_boomgardi_content_title: string | null;
  x_boomgardi_content: string | null;
  x_boomgardi_phone: string | null;
  x_show_boomgardi_phone_numbers: boolean | null;
  x_show_boomgardi_phone_numbers_from: number | null;
  // هتل set
  x_hotel_title: string | null;
  x_hotel_meta_title: string | null;
  x_hotel_meta_desc: string | null;
  x_hotel_meta_keywords: string | null;
  x_hotel_content_title: string | null;
  x_hotel_content: string | null;
  x_hotel_phone: string | null;
}

const TYPE_MAP: Record<string, LocationType> = {
  country: "COUNTRY",
  province: "PROVINCE",
  city: "CITY",
  region: "REGION",
  village: "VILLAGE",
  neighborhood: "NEIGHBORHOOD",
};

/** Odoo stores empty rich-text as "<p><br></p>"; treat that as absent. */
function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  if (!t) return null;
  if (t === "<p><br></p>" || t === "<p></p>") return null;
  return t;
}

interface SeoInput {
  residenceType: ResidenceType | null;
  pageTitle: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  metaKeywords: string | null;
  contentTitle: string | null;
  contentHtml: string | null;
  phone: string | null;
  showPhone: boolean;
  showPhoneFrom: number | null;
  showPhoneTo: number | null;
  showInHomepage: boolean;
  homepageIndex: number | null;
}

function seoSets(c: OdooCat): SeoInput[] {
  const sets: SeoInput[] = [
    {
      residenceType: null,
      pageTitle: null,
      metaTitle: clean(c.website_meta_title),
      metaDescription: clean(c.website_meta_description),
      metaKeywords: clean(c.website_meta_keywords),
      contentTitle: clean(c.x_content_title),
      contentHtml: clean(c.content),
      phone: clean(c.x_phone),
      showPhone: !!c.x_show_phone_numbers,
      showPhoneFrom: c.x_show_phone_numbers_from,
      showPhoneTo: c.x_show_phone_numbers_to,
      showInHomepage: !!c.x_homepage,
      homepageIndex: c.x_popular_index,
    },
    {
      residenceType: "BOOMGARDI",
      pageTitle: clean(c.x_boomgardi_title),
      metaTitle: clean(c.x_boomgardi_meta_title),
      metaDescription: clean(c.x_boomgardi_meta_desc),
      metaKeywords: clean(c.x_boomgardi_meta_keywords),
      contentTitle: clean(c.x_boomgardi_content_title),
      contentHtml: clean(c.x_boomgardi_content),
      phone: clean(c.x_boomgardi_phone),
      showPhone: !!c.x_show_boomgardi_phone_numbers,
      showPhoneFrom: c.x_show_boomgardi_phone_numbers_from,
      showPhoneTo: null,
      showInHomepage: !!c.x_homepage_boomgardi,
      homepageIndex: c.x_boomgardi_home_index,
    },
    {
      residenceType: "HOTEL",
      pageTitle: clean(c.x_hotel_title),
      metaTitle: clean(c.x_hotel_meta_title),
      metaDescription: clean(c.x_hotel_meta_desc),
      metaKeywords: clean(c.x_hotel_meta_keywords),
      contentTitle: clean(c.x_hotel_content_title),
      contentHtml: clean(c.x_hotel_content),
      phone: clean(c.x_hotel_phone),
      showPhone: false,
      showPhoneFrom: null,
      showPhoneTo: null,
      showInHomepage: false,
      homepageIndex: null,
    },
  ];
  // Skip sets that carry nothing at all.
  return sets.filter(
    (s) =>
      s.metaTitle ||
      s.metaDescription ||
      s.metaKeywords ||
      s.contentTitle ||
      s.contentHtml ||
      s.pageTitle ||
      s.phone ||
      s.showInHomepage
  );
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const cats = await odoo.$queryRawUnsafe<OdooCat[]>(`
    SELECT id, trim(name) AS name, parent_id, trim(x_title_en) AS x_title_en, x_category_type,
           x_canonical_category, website_published, x_asli, x_homepage, x_homepage_boomgardi,
           x_popular_index, x_shomal_sequence, x_boomgardi_home_index, x_tags, sequence,
           website_meta_title, website_meta_description, website_meta_keywords,
           x_content_title, content, x_phone, x_show_phone_numbers,
           x_show_phone_numbers_from, x_show_phone_numbers_to,
           x_boomgardi_title, x_boomgardi_meta_title, x_boomgardi_meta_desc,
           x_boomgardi_meta_keywords, x_boomgardi_content_title, x_boomgardi_content,
           x_boomgardi_phone, x_show_boomgardi_phone_numbers, x_show_boomgardi_phone_numbers_from,
           x_hotel_title, x_hotel_meta_title, x_hotel_meta_desc, x_hotel_meta_keywords,
           x_hotel_content_title, x_hotel_content, x_hotel_phone
    FROM product_public_category
  `);
  console.log(`Fetched ${cats.length} Odoo categories.`);

  const catById = new Map(cats.map((c) => [c.id, c]));
  const nameById = new Map(cats.map((c) => [c.id, c.name]));

  // ---------- 1. resolve every Odoo category to a target location id ----------
  const locations = await targetPrisma.location.findMany({
    select: { id: true, name: true, titleEn: true, type: true, odooId: true, parentId: true },
  });
  const byOdooId = new Map(locations.filter((l) => l.odooId).map((l) => [l.odooId!, l]));

  // Name keys for the first-run backfill (nothing has an odooId yet).
  const provinceByName = new Map(
    locations.filter((l) => l.type === "PROVINCE").map((l) => [l.name, l])
  );
  const cityByNameParent = new Map<string, typeof locations>();
  const cityByName = new Map<string, typeof locations>();
  const provinceNameByLocId = new Map(
    locations.filter((l) => l.type === "PROVINCE").map((l) => [l.id, l.name])
  );
  for (const l of locations.filter((x) => x.type === "CITY")) {
    const parentName = l.parentId ? provinceNameByLocId.get(l.parentId) ?? "" : "";
    const k = `${l.name}||${parentName}`;
    if (!cityByNameParent.has(k)) cityByNameParent.set(k, []);
    cityByNameParent.get(k)!.push(l);
    if (!cityByName.has(l.name)) cityByName.set(l.name, []);
    cityByName.get(l.name)!.push(l);
  }

  /** odooId -> target location id */
  const idMap = new Map<number, number>();
  const toCreate: OdooCat[] = [];
  let matchedByOdooId = 0;
  let matchedByName = 0;

  for (const c of cats) {
    // The root container is a parent sentinel, not a place — creating it would
    // give every bare /search the SEO identity of "اقامتگاه ها" (slug "s").
    if (c.id === ODOO_ROOT_ID || ODOO_IDS_TO_SKIP.has(c.id)) continue;

    const already = byOdooId.get(c.id);
    if (already) {
      idMap.set(c.id, already.id);
      matchedByOdooId++;
      continue;
    }

    // Tehran's container row maps onto the existing province row (see overrides).
    const provinceOverride = ODOO_ID_IS_PROVINCE_ROW[c.id];
    if (provinceOverride) {
      const hit = provinceByName.get(provinceOverride);
      if (hit) {
        idMap.set(c.id, hit.id);
        matchedByName++;
        continue;
      }
    }

    const type = c.x_category_type ? TYPE_MAP[c.x_category_type] : undefined;
    if (type === "PROVINCE") {
      const hit = provinceByName.get(c.name);
      if (hit) {
        idMap.set(c.id, hit.id);
        matchedByName++;
        continue;
      }
    }
    if (type === "CITY") {
      const parentName = c.parent_id ? nameById.get(c.parent_id) ?? "" : "";
      const exact = cityByNameParent.get(`${c.name}||${parentName}`);
      if (exact?.length === 1) {
        idMap.set(c.id, exact[0].id);
        matchedByName++;
        continue;
      }
      const loose = cityByName.get(c.name);
      if (loose?.length === 1) {
        idMap.set(c.id, loose[0].id);
        matchedByName++;
        continue;
      }
    }
    toCreate.push(c);
  }

  console.log(`\nResolved by odooId (already migrated): ${matchedByOdooId}`);
  console.log(`Resolved by name (first-run backfill):  ${matchedByName}`);
  console.log(`To create (never migrated):             ${toCreate.length}`);
  const byType = new Map<string, number>();
  toCreate.forEach((c) => byType.set(c.x_category_type ?? "(null)", (byType.get(c.x_category_type ?? "(null)") ?? 0) + 1));
  [...byType].forEach(([t, n]) => console.log(`    ${t}: ${n}`));
  toCreate.slice(0, 20).forEach((c) => console.log(`    + ${c.x_category_type} "${c.name}" (${c.x_title_en ?? "no slug"})`));

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  // ---------- 2. write odooId onto matched rows, create the missing ones ----------
  let backfilled = 0;
  for (const [odooId, locId] of idMap) {
    const row = byOdooId.get(odooId);
    if (row) continue; // already carried an odooId
    await targetPrisma.location.update({ where: { id: locId }, data: { odooId } });
    backfilled++;
  }
  console.log(`\nBackfilled odooId on ${backfilled} existing locations.`);

  let created = 0;
  for (const c of toCreate) {
    const type = (c.x_category_type ? TYPE_MAP[c.x_category_type] : undefined) ?? "CITY";
    const row = await targetPrisma.location.create({
      data: {
        odooId: c.id,
        type,
        name: c.name,
        titleEn: c.x_title_en,
        isPublished: c.website_published ?? true,
        isPrimary: !!c.x_asli,
        sortOrder: c.sequence ?? 0,
      },
    });
    idMap.set(c.id, row.id);
    created++;
  }
  console.log(`Created ${created} new locations.`);

  // ---------- 3. tree, canonical, flags, keywords ----------
  let treeSet = 0;
  let canonicalSet = 0;
  let selfParent = 0;
  for (const c of cats) {
    const locId = idMap.get(c.id);
    if (!locId) continue;

    // The root container ("اقامتگاه ها") is not a real place — nothing parents to it.
    let parentId: number | null = null;
    if (c.parent_id && c.parent_id !== ODOO_ROOT_ID) {
      parentId = idMap.get(c.parent_id) ?? null;
      // Odoo has self-referencing rows (تهران id 164 -> 1071 -> both map here).
      if (parentId === locId) {
        parentId = null;
        selfParent++;
      }
    }

    let canonicalId: number | null = null;
    if (c.x_canonical_category) {
      const target = idMap.get(c.x_canonical_category) ?? null;
      if (target && target !== locId) canonicalId = target;
    }

    // A row folded onto a province by ODOO_ID_IS_PROVINCE_ROW must NOT donate
    // its slug: Odoo 1071 ("تهران", slug "tehran") maps onto the province row,
    // but "tehran" belongs to the city — where the 398 listings and the indexed
    // SEO content live. Copying it here would mint a duplicate slug and let the
    // province shadow the city on /search/tehran.
    const isProvinceOverride = !!ODOO_ID_IS_PROVINCE_ROW[c.id];

    await targetPrisma.location.update({
      where: { id: locId },
      data: {
        parentId,
        canonicalId,
        keywords: clean(c.x_tags),
        isPublished: c.website_published ?? true,
        isPrimary: !!c.x_asli,
        popularIndex: c.x_popular_index || null,
        shomalIndex: c.x_shomal_sequence || null,
        sortOrder: c.sequence ?? 0,
        ...(isProvinceOverride ? { titleEn: null } : { titleEn: c.x_title_en ?? undefined }),
      },
    });
    if (parentId) treeSet++;
    if (canonicalId) canonicalSet++;
  }
  console.log(`\nParent set on ${treeSet} locations (${selfParent} self-references dropped).`);
  console.log(`Canonical set on ${canonicalSet} locations.`);

  // ---------- 4. location_includes ("شهرهای زیرمجموعه") ----------
  const includeRows = await odoo.$queryRawUnsafe<{ id1: number; id2: number }[]>(
    `SELECT id1, id2 FROM x_product_public_category_product_public_category_rel`
  );
  let includes = 0;
  let includesSkipped = 0;
  for (const r of includeRows) {
    const parentId = idMap.get(r.id1);
    const childId = idMap.get(r.id2);
    if (!parentId || !childId || parentId === childId) {
      includesSkipped++;
      continue;
    }
    await targetPrisma.locationInclude.upsert({
      where: { parentId_childId: { parentId, childId } },
      create: { parentId, childId },
      update: {},
    });
    includes++;
  }
  console.log(`\nlocation_includes: ${includes} written (${includesSkipped} unresolvable).`);

  // ---------- 5. the three SEO sets ----------
  let seoWritten = 0;
  for (const c of cats) {
    const locId = idMap.get(c.id);
    if (!locId) continue;
    for (const s of seoSets(c)) {
      const existing = await targetPrisma.locationSeo.findFirst({
        where: { locationId: locId, residenceType: s.residenceType },
      });
      if (existing) {
        await targetPrisma.locationSeo.update({ where: { id: existing.id }, data: s });
      } else {
        await targetPrisma.locationSeo.create({ data: { locationId: locId, ...s } });
      }
      seoWritten++;
    }
  }
  console.log(`location_seo rows written/updated: ${seoWritten}`);

  const counts = await targetPrisma.location.groupBy({ by: ["type"], _count: true });
  console.log(`\nFinal location counts:`);
  counts.forEach((c) => console.log(`  ${c.type}: ${c._count}`));

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
