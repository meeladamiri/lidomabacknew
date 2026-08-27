// One-off migration for the residence-detail extras the admin page shows:
//
//   1. "فاصله تا جاذبه‌های گردشگری"  x_residence_place_distance (+ x_attractions
//      for the place name) -> residence_distances
//   2. "دیگر شهرهای اقامتگاه"       product_public_category_product_template_rel
//      (city-type categories other than the residence's primary city)
//      -> residence_cities
//   3. "نام پیشنهادی میزبان"        product_template.x_host_display_name
//      -> Residence.hostSuggestedName
//   4. "آدرس در فاکتور"             product_template.x_address (the long form;
//      the public page keeps the coarser address already migrated)
//      -> Residence.invoiceAddress
//
// Idempotent: distances/cities are diffed per residence, scalars are plain
// updates.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-residence-extras.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-residence-extras.ts --commit        # writes

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const BATCH = 1000;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  // reference -> internal id for every migrated residence
  const residences = await targetPrisma.residence.findMany({
    where: { reference: { startsWith: "ODOO-" } },
    select: { id: true, reference: true },
  });
  const byTmpl = new Map<number, number>();
  for (const r of residences) byTmpl.set(Number(r.reference!.slice(5)), r.id);
  console.log(`${byTmpl.size} migrated residences.`);

  // ---------- 1) distances ----------
  const distanceRows = await odoo.$queryRawUnsafe<
    { tmpl: number; place: string; distance: string | null; eta: string | null }[]
  >(`
    SELECT pp.product_tmpl_id AS tmpl, trim(a.x_name) AS place,
           d.x_distance AS distance, d.x_eta AS eta
    FROM x_residence_place_distance d
    JOIN product_product pp ON pp.id = d.x_product_id
    JOIN x_attractions a ON a.id = d.x_place
    WHERE a.x_name IS NOT NULL
  `);
  console.log(`Fetched ${distanceRows.length} distance rows.`);

  const wantDistances = new Map<number, { placeName: string; distance: string | null; eta: string | null }[]>();
  for (const d of distanceRows) {
    const residenceId = byTmpl.get(d.tmpl);
    if (!residenceId) continue;
    const list = wantDistances.get(residenceId) ?? [];
    if (list.some((x) => x.placeName === d.place)) continue; // dedupe
    list.push({ placeName: d.place, distance: d.distance, eta: d.eta });
    wantDistances.set(residenceId, list);
  }
  const distanceTotal = [...wantDistances.values()].reduce((n, l) => n + l.length, 0);
  console.log(`Planned distances: ${distanceTotal} across ${wantDistances.size} residences.`);

  // ---------- 2) extra cities ----------
  const cityRows = await odoo.$queryRawUnsafe<{ tmpl: number; name: string }[]>(`
    SELECT rel.product_template_id AS tmpl, trim(c.name) AS name
    FROM product_public_category_product_template_rel rel
    JOIN product_public_category c ON c.id = rel.product_public_category_id
    WHERE c.x_category_type = 'city'
  `);
  console.log(`Fetched ${cityRows.length} template<->city links.`);

  const cityIdByName = new Map<string, number>();
  for (const c of await targetPrisma.city.findMany({ select: { id: true, name: true } })) {
    if (!cityIdByName.has(c.name)) cityIdByName.set(c.name, c.id);
  }
  const primaryCity = new Map<number, number | null>();
  for (const r of await targetPrisma.residence.findMany({ select: { id: true, cityId: true } })) {
    primaryCity.set(r.id, r.cityId);
  }

  const wantCities = new Map<number, Set<number>>();
  for (const row of cityRows) {
    const residenceId = byTmpl.get(row.tmpl);
    const cityId = cityIdByName.get(row.name);
    if (!residenceId || !cityId) continue;
    if (primaryCity.get(residenceId) === cityId) continue; // not an "extra" city
    const set = wantCities.get(residenceId) ?? new Set<number>();
    set.add(cityId);
    wantCities.set(residenceId, set);
  }
  const cityTotal = [...wantCities.values()].reduce((n, s) => n + s.size, 0);
  console.log(`Planned extra cities: ${cityTotal} across ${wantCities.size} residences.`);

  // ---------- 3+4) scalars ----------
  const scalarRows = await odoo.$queryRawUnsafe<
    { id: number; host_name: string | null; address: string | null }[]
  >(`
    SELECT id, trim(x_host_display_name) AS host_name, trim(x_address) AS address
    FROM product_template
    WHERE website_published = true
      AND (x_host_display_name IS NOT NULL OR x_address IS NOT NULL)
  `);
  console.log(`Templates with a suggested name / invoice address: ${scalarRows.length}`);

  if (!COMMIT) {
    console.log("\nDry run complete — re-run with --commit to write.");
    return;
  }

  // write distances (replace per residence so re-runs converge)
  let distWritten = 0;
  const distIds = [...wantDistances.keys()];
  for (let i = 0; i < distIds.length; i += 200) {
    const chunk = distIds.slice(i, i + 200);
    await targetPrisma.residenceDistance.deleteMany({ where: { residenceId: { in: chunk } } });
    const data = chunk.flatMap((residenceId) =>
      (wantDistances.get(residenceId) ?? []).map((d, idx) => ({
        residenceId,
        placeName: d.placeName,
        distance: d.distance,
        eta: d.eta,
        sortOrder: idx,
      }))
    );
    for (let j = 0; j < data.length; j += BATCH) {
      const res = await targetPrisma.residenceDistance.createMany({ data: data.slice(j, j + BATCH) });
      distWritten += res.count;
    }
    if (i % 2000 === 0) console.log(`  distances: ${i}/${distIds.length} residences`);
  }
  console.log(`Distances written: ${distWritten}`);

  // write extra cities
  const cityData = [...wantCities.entries()].flatMap(([residenceId, set]) =>
    [...set].map((cityId) => ({ residenceId, cityId }))
  );
  let cityWritten = 0;
  for (let i = 0; i < cityData.length; i += BATCH) {
    const res = await targetPrisma.residenceCity.createMany({
      data: cityData.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    cityWritten += res.count;
  }
  console.log(`Extra cities written: ${cityWritten}`);

  // write scalars
  let scalarWritten = 0;
  for (const row of scalarRows) {
    const residenceId = byTmpl.get(row.id);
    if (!residenceId) continue;
    await targetPrisma.residence.update({
      where: { id: residenceId },
      data: {
        ...(row.host_name ? { hostSuggestedName: row.host_name } : {}),
        ...(row.address ? { invoiceAddress: row.address } : {}),
      },
    });
    scalarWritten++;
    if (scalarWritten % 2000 === 0) console.log(`  scalars: ${scalarWritten}/${scalarRows.length}`);
  }
  console.log(`Scalars updated: ${scalarWritten}`);
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
