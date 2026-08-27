// One-off migration (companion to migrate-odoo-amenities.ts — run AFTER it):
// the "details" layer of the legacy Odoo amenity system.
//
//   1. Sub-feature DEFINITIONS  product_attribute.x_extra_info (JSON array of
//      {name, field_type: dropdown|text|switch, values, placeholder}) ->
//      AmenityFeature rows (replaced wholesale per amenity, idempotent).
//   2. Per-residence sub-feature ANSWERS  product_template.x_extra_amenities
//      (JSON keyed by attribute id -> {subFeatureName: answer, "توضیحات": …})
//      -> merged into ResidenceAmenity.extraFeatures as {value, extra:{…}}.
//      The frontend detail page shows these as "توضیحات بیشتر" per facility.
//   3. Host free-text rules  product_template.x_extra_rules (JSON with a
//      "desc" key) -> Residence.extraRules.
//   4. Boomgardi free-text features  product_template.x_features
//      ("#%"-joined names) -> Residence.boomgardiFeatures (string[]).
//   5. Attribute ICONS  product_attribute.x_icon (base64 SVG stored in-table,
//      33 of 47 attrs) -> written to front/public/assets/amenity-icons/
//      <key>.svg and Amenity.iconUrl set to that public path.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-amenity-details.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-amenity-details.ts --commit        # writes

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const ICONS_DIR = path.resolve(__dirname, "../../front/public/assets/amenity-icons");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

const FIELD_TYPE_MAP: Record<string, "TEXT" | "DROPDOWN" | "SWITCH" | "CHECKBOX"> = {
  text: "TEXT",
  dropdown: "DROPDOWN",
  switch: "SWITCH",
  checkbox: "CHECKBOX",
};

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);

  // amenity catalog: odoo attribute id -> new amenity (via key)
  const attrs = await odoo.$queryRawUnsafe<
    { id: number; key: string | null; x_extra_info: string | null; icon_b64: string | null }[]
  >(`
    SELECT id, trim(x_title_en) AS key, x_extra_info,
           convert_from(x_icon, 'UTF8') AS icon_b64
    FROM product_attribute
  `);
  const amenities = await targetPrisma.amenity.findMany({ where: { key: { not: null } } });
  const amenityByKey = new Map(amenities.map((a) => [a.key!, a]));
  const amenityIdByAttr = new Map<number, number>();
  for (const a of attrs) {
    const m = a.key ? amenityByKey.get(a.key) : undefined;
    if (m) amenityIdByAttr.set(a.id, m.id);
  }

  // ---------- 1) Sub-feature definitions ----------
  let defsCreated = 0;
  for (const a of attrs) {
    const amenityId = a.key ? amenityByKey.get(a.key)?.id : undefined;
    if (!amenityId || !a.x_extra_info) continue;
    let defs: any[];
    try {
      defs = JSON.parse(a.x_extra_info);
    } catch {
      continue;
    }
    if (!Array.isArray(defs) || !defs.length) continue;
    if (COMMIT) {
      await targetPrisma.amenityFeature.deleteMany({ where: { amenityId } });
      await targetPrisma.amenityFeature.createMany({
        data: defs
          .filter((d) => d?.name && FIELD_TYPE_MAP[d.field_type])
          .map((d) => ({
            amenityId,
            fieldType: FIELD_TYPE_MAP[d.field_type],
            name: String(d.name),
            placeholder: d.placeholder ? String(d.placeholder) : null,
            values: d.values ? String(d.values) : null,
          })),
      });
    }
    defsCreated += defs.length;
  }
  console.log(`Sub-feature definitions ${COMMIT ? "written" : "found"}: ${defsCreated}`);

  // ---------- 2) Icons ----------
  if (COMMIT) fs.mkdirSync(ICONS_DIR, { recursive: true });
  let icons = 0;
  for (const a of attrs) {
    if (!a.key || !a.icon_b64) continue;
    const amenity = amenityByKey.get(a.key);
    if (!amenity) continue;
    let svg: Buffer;
    try {
      svg = Buffer.from(a.icon_b64, "base64");
    } catch {
      continue;
    }
    const rel = `/assets/amenity-icons/${a.key}.svg`;
    if (COMMIT) {
      fs.writeFileSync(path.join(ICONS_DIR, `${a.key}.svg`), svg);
      await targetPrisma.amenity.update({ where: { id: amenity.id }, data: { iconUrl: rel } });
    }
    icons++;
  }
  console.log(`Icons ${COMMIT ? "written" : "found"}: ${icons} -> ${ICONS_DIR}`);

  // ---------- 3+4+5) Per-residence data ----------
  const residences = await targetPrisma.residence.findMany({
    where: { reference: { startsWith: "ODOO-" } },
    select: { id: true, reference: true },
  });
  const residenceByTmpl = new Map<number, number>();
  for (const r of residences) residenceByTmpl.set(Number(r.reference!.slice(5)), r.id);

  const templates = await odoo.$queryRawUnsafe<
    { id: number; x_extra_amenities: string | null; x_extra_rules: string | null; x_features: string | null }[]
  >(`
    SELECT id, x_extra_amenities, x_extra_rules, x_features
    FROM product_template
    WHERE website_published = true
      AND (x_extra_amenities IS NOT NULL OR x_extra_rules IS NOT NULL OR x_features IS NOT NULL)
  `);
  console.log(`Templates with extra data: ${templates.length}`);

  // preload amenity links to merge answers into
  const links = await targetPrisma.residenceAmenity.findMany({
    select: { id: true, residenceId: true, amenityId: true, extraFeatures: true },
  });
  const linkByKey = new Map(links.map((l) => [`${l.residenceId}:${l.amenityId}`, l]));

  let answersMerged = 0;
  let rulesSet = 0;
  let boomFeatures = 0;
  let processed = 0;

  for (const t of templates) {
    const residenceId = residenceByTmpl.get(t.id);
    if (!residenceId) continue;
    processed++;

    // 3) sub-feature answers
    if (t.x_extra_amenities) {
      try {
        const parsed = JSON.parse(t.x_extra_amenities) as Record<string, any>;
        for (const [attrIdStr, answers] of Object.entries(parsed)) {
          if (!answers || typeof answers !== "object" || !Object.keys(answers).length) continue;
          const amenityId = amenityIdByAttr.get(Number(attrIdStr));
          if (!amenityId) continue;
          const link = linkByKey.get(`${residenceId}:${amenityId}`);
          if (!link) continue; // residence doesn't have this amenity linked
          const current = (link.extraFeatures as any) ?? {};
          const nextExtra = answers as Record<string, string>;
          if (JSON.stringify(current.extra) !== JSON.stringify(nextExtra)) {
            if (COMMIT) {
              await targetPrisma.residenceAmenity.update({
                where: { id: link.id },
                data: { extraFeatures: { ...current, extra: nextExtra } },
              });
            }
            answersMerged++;
          }
        }
      } catch {
        /* malformed JSON — skip */
      }
    }

    // 4) host free-text rules
    if (t.x_extra_rules) {
      try {
        const parsed = JSON.parse(t.x_extra_rules);
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length) {
          if (COMMIT) {
            await targetPrisma.residence.update({ where: { id: residenceId }, data: { extraRules: parsed } });
          }
          rulesSet++;
        }
      } catch {
        /* skip */
      }
    }

    // 5) boomgardi free-text features
    if (t.x_features) {
      const names = t.x_features.split("#%").map((s) => s.trim()).filter(Boolean);
      if (names.length) {
        if (COMMIT) {
          await targetPrisma.residence.update({
            where: { id: residenceId },
            data: { boomgardiFeatures: names },
          });
        }
        boomFeatures++;
      }
    }
  }

  console.log(`Residences processed: ${processed}`);
  console.log(`Sub-feature answers ${COMMIT ? "merged" : "to merge"}: ${answersMerged}`);
  console.log(`extraRules ${COMMIT ? "set" : "to set"}: ${rulesSet}`);
  console.log(`boomgardiFeatures ${COMMIT ? "set" : "to set"}: ${boomFeatures}`);
  if (!COMMIT) console.log("\nDry run complete — re-run with --commit to write.");
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
