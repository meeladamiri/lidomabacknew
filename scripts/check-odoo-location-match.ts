// Pre-flight gate for the Location tree migration (read-only, never writes).
//
// The original city/province migration never stored an Odoo id — both
// migrate-odoo-cities.ts and fix-city-slugs-from-odoo.ts re-match rows by
// (trimmed name, parent province name). Every later migration that wants to
// attach Odoo data to a place (per-type SEO, sub-locations, the 9,969 tag_url
// pages keyed by x_category_id) therefore depends on that name key still
// resolving. This script measures exactly how well it does, and lists every
// row it cannot match so they can be handled deliberately rather than
// silently dropped.
//
// Usage:
//   npx tsx --env-file=.env scripts/check-odoo-location-match.ts

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";
import { ODOO_ID_IS_PROVINCE_ROW, ODOO_IDS_TO_SKIP } from "./odooLocationOverrides";

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
}

async function main() {
  const cats = await odoo.$queryRawUnsafe<OdooCat[]>(`
    SELECT id, trim(name) AS name, parent_id, trim(x_title_en) AS x_title_en, x_category_type
    FROM product_public_category
  `);
  console.log(`Odoo product_public_category rows: ${cats.length}`);

  const byType = new Map<string, OdooCat[]>();
  for (const c of cats) {
    const t = c.x_category_type ?? "(null)";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(c);
  }
  console.log("\nBy type:");
  for (const [t, rows] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${t.padEnd(14)} ${rows.length}`);
  }

  const nameById = new Map(cats.map((c) => [c.id, c.name]));

  const [targetCities, targetProvinces] = await Promise.all([
    targetPrisma.city.findMany({ include: { province: { select: { name: true } } } }),
    targetPrisma.province.findMany(),
  ]);
  console.log(`\nTarget DB: ${targetCities.length} cities, ${targetProvinces.length} provinces`);

  // ---- provinces ----
  const provinceByName = new Map(targetProvinces.map((p) => [p.name, p]));
  const odooProvinces = byType.get("province") ?? [];
  const provinceMisses = odooProvinces.filter((p) => !provinceByName.has(p.name));
  console.log(
    `\nProvinces matched by name: ${odooProvinces.length - provinceMisses.length}/${odooProvinces.length}`
  );
  provinceMisses.forEach((p) => console.log(`  MISS  id=${p.id} "${p.name}" slug=${p.x_title_en}`));

  // ---- cities ----
  // Same key the original migration used: (name, parent province name).
  const cityKey = (name: string, province: string | null | undefined) => `${name}||${province ?? ""}`;
  const cityIndex = new Map<string, typeof targetCities>();
  for (const c of targetCities) {
    const k = cityKey(c.name, c.province?.name);
    if (!cityIndex.has(k)) cityIndex.set(k, []);
    cityIndex.get(k)!.push(c);
  }
  // Fallback index on name alone, to distinguish "wrong province" from "absent".
  const cityByNameOnly = new Map<string, typeof targetCities>();
  for (const c of targetCities) {
    if (!cityByNameOnly.has(c.name)) cityByNameOnly.set(c.name, []);
    cityByNameOnly.get(c.name)!.push(c);
  }

  const typeById = new Map(cats.map((c) => [c.id, c.x_category_type ?? "(null)"]));
  const odooCities = byType.get("city") ?? [];
  const exact: OdooCat[] = [];
  /** name matches and the target row has NO province — the original migration
   *  simply couldn't resolve a province-typed parent, so this is safe. */
  const nameOnlyNullProvince: OdooCat[] = [];
  /** name matches but the target row sits under a DIFFERENT province — a real
   *  conflict that would silently attach Odoo data to the wrong place. */
  const nameOnlyConflict: OdooCat[] = [];
  const absent: OdooCat[] = [];
  const ambiguous: OdooCat[] = [];

  const overrideProvince: OdooCat[] = [];

  for (const c of odooCities) {
    if (ODOO_IDS_TO_SKIP.has(c.id)) continue;
    if (ODOO_ID_IS_PROVINCE_ROW[c.id]) {
      overrideProvince.push(c);
      continue;
    }
    const provinceName = c.parent_id ? nameById.get(c.parent_id) : undefined;
    const hit = cityIndex.get(cityKey(c.name, provinceName));
    if (hit && hit.length === 1) {
      exact.push(c);
      continue;
    }
    if (hit && hit.length > 1) {
      ambiguous.push(c);
      continue;
    }
    const byName = cityByNameOnly.get(c.name);
    if (!byName) {
      absent.push(c);
      continue;
    }
    if (byName.length === 1 && byName[0].province == null) nameOnlyNullProvince.push(c);
    else nameOnlyConflict.push(c);
  }

  console.log(`\nCities:`);
  console.log(`  exact (name + province):           ${exact.length}`);
  console.log(`  name match, target has no province: ${nameOnlyNullProvince.length}  (safe)`);
  console.log(`  name match, DIFFERENT province:     ${nameOnlyConflict.length}  (conflict)`);
  console.log(`  ambiguous (duplicate key):          ${ambiguous.length}`);
  console.log(`  absent from target:                 ${absent.length}`);
  console.log(`  hand-resolved to a province row:    ${overrideProvince.length}  (see odooLocationOverrides.ts)`);
  console.log(`  deliberately skipped:               ${ODOO_IDS_TO_SKIP.size}  (junk categories, never migrated)`);

  const show = (label: string, rows: OdooCat[], limit = 25) => {
    if (!rows.length) return;
    console.log(`\n${label}:`);
    rows.slice(0, limit).forEach((c) => {
      const p = c.parent_id ? nameById.get(c.parent_id) : "(no parent)";
      const pt = c.parent_id ? typeById.get(c.parent_id) : "-";
      console.log(
        `  id=${String(c.id).padEnd(5)} "${c.name}" parent="${p}" (${pt}) slug=${c.x_title_en ?? "-"}`
      );
    });
    if (rows.length > limit) console.log(`  … and ${rows.length - limit} more`);
  };
  show(
    "Name match with no province in target — parent was a country/city/root, so the old migration left it null",
    nameOnlyNullProvince
  );
  show("Name match under a DIFFERENT province (must be resolved by hand)", nameOnlyConflict);
  show("Ambiguous", ambiguous);
  show("Absent from target (their Odoo data cannot be attached)", absent);

  // Target provinces with no Odoo counterpart — the target has 28 vs Odoo's 27.
  const odooProvinceNames = new Set(odooProvinces.map((p) => p.name));
  const strayProvinces = targetProvinces.filter((p) => !odooProvinceNames.has(p.name));
  if (strayProvinces.length) {
    console.log(`\nTarget provinces with no Odoo counterpart:`);
    for (const p of strayProvinces) {
      const cityCount = targetCities.filter((c) => c.provinceId === p.id).length;
      console.log(
        `  id=${p.id} "${p.name}" slug=${p.titleEn ?? "-"} — ${cityCount} cities attached`
      );
    }
  }

  // ---- types that were never migrated at all ----
  const newTypes = ["country", "region", "village", "neighborhood"];
  console.log(`\nTypes never migrated (will be inserted fresh):`);
  for (const t of newTypes) {
    const rows = byType.get(t) ?? [];
    console.log(`  ${t.padEnd(14)} ${rows.length}  ${rows.map((r) => r.name).join("، ")}`);
  }
  const nulls = byType.get("(null)") ?? [];
  if (nulls.length) {
    console.log(`\nRows with no x_category_type (need a manual call):`);
    nulls.forEach((c) => console.log(`  id=${c.id} "${c.name}" slug=${c.x_title_en ?? "-"}`));
  }

  // ---- tag_url reachability, the reason this gate matters ----
  const tagUrlCats = await odoo.$queryRawUnsafe<{ cnt: number; cats: number }[]>(`
    SELECT count(*)::int AS cnt, count(DISTINCT x_category_id)::int AS cats FROM tag_url
  `);
  console.log(
    `\ntag_url rows: ${tagUrlCats[0].cnt} across ${tagUrlCats[0].cats} distinct categories ` +
      `— each needs its category resolvable to carry its hand-written SEO across.`
  );

  const blocking = provinceMisses.length + ambiguous.length + absent.length + nameOnlyConflict.length;
  console.log(
    blocking === 0
      ? `\nGATE PASS — every Odoo province and city resolves to exactly one target row.`
      : `\nGATE FAIL — ${blocking} row(s) cannot be resolved unambiguously (see above).`
  );
  if (blocking > 0) process.exitCode = 1;
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
