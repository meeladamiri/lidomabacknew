// One-off migration: legacy Odoo's attribute system -> amenities/rules
// catalogs + per-residence links.
//
// Odoo structure (the REAL source — x_rooms_features, the table this was
// once expected to come from, is completely empty):
//   product_attribute            47 hand-curated attributes with English
//                                keys in x_title_en (pool, jacuzzi, type,
//                                area, smoking, ...), grouped via
//                                x_category -> x_attribute_category
//   product_attribute_value      109 values ("دارد"/"ندارد", or categorical
//                                like خانه ویلایی / جنگلی / سیاست متعادل)
//   extra_features_line          template <-> attribute   (~434k rows)
//   product_extra_features       line <-> value           (~429k rows)
//
// Taxonomy decisions:
//   - Attributes 45 (cancellation) and 244-249 (smoking/pets/events/24h/
//     singles/id-required) become RULES — their value (مجاز/ممنوع style) is
//     stored per residence in ResidenceRule.value.
//   - Everything else becomes an AMENITY. Binary "ندارد" links are NOT
//     stored (absence of the link = doesn't have it); the value name is kept
//     in ResidenceAmenity.extraFeatures = {value} (categorical attrs like
//     type/area/rent-type keep their real value there, multi-values joined
//     with "، ").
//   - Amenity.key / Rule.key = x_title_en — the stable identifier search-tag
//     filters (?pool=1) match on.
//
// Idempotent: catalog upserted by key; links diffed against desired state.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-amenities.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-amenities.ts --commit        # writes

import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const BATCH = 1000;

const RULE_ATTR_KEYS = new Set([
  "cancellation",
  "smoking",
  "pets",
  "events",
  "24h",
  "singles",
  "id-required",
]);

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface AttrRow {
  id: number;
  name: string;
  key: string | null;
  category: string | null;
}
interface LinkRow {
  tmpl: number;
  attr_id: number;
  val: string;
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  // ---------- 1) Catalog ----------
  const attrs = await odoo.$queryRawUnsafe<AttrRow[]>(`
    SELECT a.id, trim(a.name) AS name, trim(a.x_title_en) AS key, c.x_name AS category
    FROM product_attribute a
    LEFT JOIN x_attribute_category c ON c.id = a.x_category
    ORDER BY a.sequence, a.id
  `);
  console.log(`Fetched ${attrs.length} attributes.`);

  const amenityIdByAttr = new Map<number, number>();
  const ruleIdByAttr = new Map<number, number>();

  for (const a of attrs) {
    if (!a.key) continue;
    const isRule = RULE_ATTR_KEYS.has(a.key);
    if (!COMMIT) {
      console.log(`  ${isRule ? "RULE   " : "AMENITY"}  ${a.key}  (${a.name})  [${a.category ?? "-"}]`);
      continue;
    }
    if (isRule) {
      const row = await targetPrisma.rule.upsert({
        where: { key: a.key },
        create: { key: a.key, name: a.name, category: a.category ?? "مقررات اقامتگاه" },
        update: { name: a.name, category: a.category ?? "مقررات اقامتگاه" },
      });
      ruleIdByAttr.set(a.id, row.id);
    } else {
      const row = await targetPrisma.amenity.upsert({
        where: { key: a.key },
        create: { key: a.key, name: a.name, category: a.category ?? "امکانات" },
        update: { name: a.name, category: a.category ?? "امکانات" },
      });
      amenityIdByAttr.set(a.id, row.id);
    }
  }
  if (COMMIT) console.log(`Catalog ready: ${amenityIdByAttr.size} amenities, ${ruleIdByAttr.size} rules.`);

  // ---------- 2) Residence links ----------
  const residences = await targetPrisma.residence.findMany({
    where: { reference: { startsWith: "ODOO-" } },
    select: { id: true, reference: true },
  });
  const residenceByTmpl = new Map<number, number>();
  for (const r of residences) residenceByTmpl.set(Number(r.reference!.slice(5)), r.id);
  console.log(`${residenceByTmpl.size} migrated residences to link.`);

  const links = await odoo.$queryRawUnsafe<LinkRow[]>(`
    SELECT l.extra_product_tmpl_id AS tmpl, l.attribute_id AS attr_id, trim(v.name) AS val
    FROM extra_features_line l
    JOIN product_template pt ON pt.id = l.extra_product_tmpl_id AND pt.website_published = true
    JOIN product_extra_features rel ON rel.line_id = l.id
    JOIN product_attribute_value v ON v.id = rel.val_id
  `);
  console.log(`Fetched ${links.length} attribute-value links for published templates.`);

  // desired state: (residenceId, amenityId) -> merged value | (residenceId, ruleId) -> value
  const wantAmenity = new Map<string, { residenceId: number; amenityId: number; values: string[] }>();
  const wantRule = new Map<string, { residenceId: number; ruleId: number; value: string }>();
  let skippedNoResidence = 0;

  const isRuleAttr = new Map<number, boolean>();
  for (const a of attrs) if (a.key) isRuleAttr.set(a.id, RULE_ATTR_KEYS.has(a.key));

  for (const l of links) {
    const residenceId = residenceByTmpl.get(l.tmpl);
    if (!residenceId) {
      skippedNoResidence++;
      continue;
    }
    if (isRuleAttr.get(l.attr_id) === true) {
      const ruleId = ruleIdByAttr.get(l.attr_id);
      if (!ruleId) continue; // dry run has empty maps
      wantRule.set(`${residenceId}:${ruleId}`, { residenceId, ruleId, value: l.val });
    } else if (isRuleAttr.get(l.attr_id) === false) {
      if (l.val === "ندارد") continue; // absence of link = doesn't have it
      const amenityId = amenityIdByAttr.get(l.attr_id);
      if (!amenityId) continue;
      const k = `${residenceId}:${amenityId}`;
      const cur = wantAmenity.get(k) ?? { residenceId, amenityId, values: [] };
      if (!cur.values.includes(l.val)) cur.values.push(l.val);
      wantAmenity.set(k, cur);
    }
  }
  console.log(
    `Planned: ${wantAmenity.size || "(commit-only)"} residence-amenity links, ${
      wantRule.size || "(commit-only)"
    } residence-rule links (links on unmigrated templates: ${skippedNoResidence}).`
  );

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  // ---------- 3) Write links (diff against existing) ----------
  const existingA = await targetPrisma.residenceAmenity.findMany({
    select: { id: true, residenceId: true, amenityId: true, extraFeatures: true },
  });
  const existingAByKey = new Map(existingA.map((e) => [`${e.residenceId}:${e.amenityId}`, e]));

  const toCreateA: { residenceId: number; amenityId: number; extraFeatures: { value: string } }[] = [];
  let updatedA = 0;
  for (const [k, w] of wantAmenity) {
    const value = w.values.join("، ");
    const ex = existingAByKey.get(k);
    if (!ex) {
      toCreateA.push({ residenceId: w.residenceId, amenityId: w.amenityId, extraFeatures: { value } });
    } else if ((ex.extraFeatures as any)?.value !== value) {
      await targetPrisma.residenceAmenity.update({ where: { id: ex.id }, data: { extraFeatures: { value } } });
      updatedA++;
    }
  }
  let createdA = 0;
  for (let i = 0; i < toCreateA.length; i += BATCH) {
    const res = await targetPrisma.residenceAmenity.createMany({
      data: toCreateA.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    createdA += res.count;
    if (i % 20000 === 0) console.log(`  amenity links: ${i + res.count}/${toCreateA.length}`);
  }
  console.log(`Residence-amenity links: created ${createdA}, updated ${updatedA}.`);

  const existingR = await targetPrisma.residenceRule.findMany({
    select: { id: true, residenceId: true, ruleId: true, value: true },
  });
  const existingRByKey = new Map(existingR.map((e) => [`${e.residenceId}:${e.ruleId}`, e]));

  const toCreateR: { residenceId: number; ruleId: number; value: string }[] = [];
  let updatedR = 0;
  for (const [k, w] of wantRule) {
    const ex = existingRByKey.get(k);
    if (!ex) toCreateR.push({ residenceId: w.residenceId, ruleId: w.ruleId, value: w.value });
    else if (ex.value !== w.value) {
      await targetPrisma.residenceRule.update({ where: { id: ex.id }, data: { value: w.value } });
      updatedR++;
    }
  }
  let createdR = 0;
  for (let i = 0; i < toCreateR.length; i += BATCH) {
    const res = await targetPrisma.residenceRule.createMany({
      data: toCreateR.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    createdR += res.count;
  }
  console.log(`Residence-rule links: created ${createdR}, updated ${updatedR}.`);
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
