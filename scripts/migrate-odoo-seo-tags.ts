// Imports the 18 legacy Odoo `website_tags` rows into seo_tags +
// seo_tag_conditions, translating each tag's `x_domain` into stored filter
// conditions so the search service stops hardcoding them.
//
// Odoo domains are prefix-notation with an implicit AND between the top-level
// expressions, e.g.
//     [A, '|', B, C]   ==  A AND (B OR C)
// The importer parses that into groups: conditions inside a group are OR-ed,
// groups are AND-ed — which is exactly how searchResidences builds its WHERE.
//
// This matters because the current hardcoded filters DISAGREE with Odoo:
//   pool    Odoo = استخر AND خانه ویلایی      code = استخر only
//   village Odoo = خانه روستایی AND (روستایی OR حومه شهر)  code = روستایی only
// so today's tag pages return different listings than production.
//
// Only 18 rows, all hand-written by the ops team — the dry run prints every
// parsed domain so each can be eyeballed before committing.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-seo-tags.ts             # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-seo-tags.ts --commit    # writes

import { PrismaClient, type ResidenceType } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

// Short chip labels the frontend renders in breadcrumbs/filters
// (front/constants/search/tags.ts) — folded in so there is one vocabulary.
const SHORT_LABELS: Record<string, string> = {
  villa: "ویلا",
  apartment: "آپارتمان",
  boomgardi: "بوم گردی",
  hotelapartment: "هتل آپارتمان",
  cottage: "کلبه",
  guesthouse: "مهمان خانه",
  economic: "ارزان",
  luxury: "لوکس",
  jacuzzi: "جکوزی",
  pool: "استخردار",
  beach: "ساحلی",
  mountain: "کوهستانی",
  forest: "جنگلی",
  village: "روستایی",
};

interface OdooTag {
  id: number;
  x_title: string | null;
  x_name: string | null;
  x_type: string | null;
  x_desc: string | null;
  x_domain: string | null;
  x_price_range: string | null;
  x_suggest: boolean | null;
  x_sequence: number | null;
  x_content: string | null;
  x_content_title: string | null;
  x_show_in_shomal: boolean | null;
  x_show_in_homepage: boolean | null;
  x_homepage_sequence: number | null;
}

// ---------------------------------------------------------------- domain parsing

type Leaf = { field: string; op: string; value: string };
type Node = Leaf | { or: Node[] } | { and: Node[] };
type Token = { kind: "op"; op: "&" | "|" | "!" } | { kind: "leaf"; leaf: Leaf };

function tokenize(domain: string): Token[] {
  const tokens: Token[] = [];
  // Either a bare operator string, or a ('field', 'op', value) triple.
  const re = /'([|&!])'|\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(domain))) {
    if (m[1]) tokens.push({ kind: "op", op: m[1] as "&" | "|" | "!" });
    else tokens.push({ kind: "leaf", leaf: { field: m[2], op: m[3], value: m[4].trim() } });
  }
  return tokens;
}

/** Consumes one prefix-notation expression from `tokens` starting at `i`. */
function parseExpr(tokens: Token[], i: number): [Node, number] {
  const t = tokens[i];
  if (!t) throw new Error("unexpected end of domain");
  if (t.kind === "op") {
    if (t.op === "!") {
      // No legacy tag uses negation; fail loudly rather than silently mis-filter.
      throw new Error("'!' (NOT) in domain is not supported");
    }
    const [left, i1] = parseExpr(tokens, i + 1);
    const [right, i2] = parseExpr(tokens, i1);
    return [t.op === "|" ? { or: [left, right] } : { and: [left, right] }, i2];
  }
  return [t.leaf, i + 1];
}

/** Top level is an implicit AND of consecutive expressions. */
function parseDomain(domain: string): Node[] {
  const tokens = tokenize(domain);
  const parts: Node[] = [];
  let i = 0;
  while (i < tokens.length) {
    const [node, next] = parseExpr(tokens, i);
    parts.push(node);
    i = next;
  }
  return parts;
}

/** Flattens an AND-of-(OR-of-leaves) tree into groups of leaves. */
function toGroups(nodes: Node[]): Leaf[][] {
  const groups: Leaf[][] = [];
  const visitAnd = (n: Node) => {
    if ("and" in n) {
      n.and.forEach(visitAnd);
    } else if ("or" in n) {
      const leaves: Leaf[] = [];
      const collectOr = (x: Node) => {
        if ("or" in x) x.or.forEach(collectOr);
        else if ("and" in x) throw new Error("AND nested inside OR is not supported");
        else leaves.push(x);
      };
      collectOr(n);
      groups.push(leaves);
    } else {
      groups.push([n]);
    }
  };
  nodes.forEach(visitAnd);
  return groups;
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const tags = await odoo.$queryRawUnsafe<OdooTag[]>(`
    SELECT id, trim(x_title) AS x_title, x_name, x_type, x_desc, x_domain, x_price_range,
           x_suggest, x_sequence, x_content, x_content_title,
           x_show_in_shomal, x_show_in_homepage, x_homepage_sequence
    FROM website_tags ORDER BY COALESCE(x_sequence, 999), id
  `);
  console.log(`Fetched ${tags.length} Odoo website_tags.`);

  // attribute value id -> (attribute key, value name)
  const attrValues = await odoo.$queryRawUnsafe<
    { id: number; value_name: string; attr_key: string | null; attr_name: string }[]
  >(`
    SELECT pav.id, pav.name::text AS value_name, trim(pa.x_title_en) AS attr_key, pa.name::text AS attr_name
    FROM product_attribute_value pav JOIN product_attribute pa ON pa.id = pav.attribute_id
  `);
  const valueById = new Map(attrValues.map((v) => [v.id, v]));

  const [amenities, rules] = await Promise.all([
    targetPrisma.amenity.findMany({ select: { key: true } }),
    targetPrisma.rule.findMany({ select: { key: true } }),
  ]);
  const amenityKeys = new Set(amenities.map((a) => a.key).filter(Boolean) as string[]);
  const ruleKeys = new Set(rules.map((r) => r.key).filter(Boolean) as string[]);

  interface Prepared {
    tag: OdooTag;
    key: string;
    conditions: { groupIndex: number; amenityKey: string | null; ruleKey: string | null; valueName: string | null }[];
    priceMin: number | null;
    priceMax: number | null;
    matchIsFast: boolean;
    residenceType: ResidenceType | null;
    /** A clause referenced something that no longer exists, so the tag cannot
     *  be reproduced faithfully. Imported deactivated rather than under-filtered. */
    unresolvable: boolean;
    warnings: string[];
  }

  const prepared: Prepared[] = [];

  for (const t of tags) {
    const key = t.x_title?.trim();
    if (!key) continue;

    const warnings: string[] = [];
    let unresolvable = false;
    let priceMin: number | null = null;
    let priceMax: number | null = null;
    let matchIsFast = false;
    let residenceType: ResidenceType | null =
      t.x_type === "boomgardi" ? "BOOMGARDI" : t.x_type === "hotel" ? "HOTEL" : null;

    const conditions: Prepared["conditions"] = [];

    let groups: Leaf[][] = [];
    try {
      groups = toGroups(parseDomain(t.x_domain ?? ""));
    } catch (e) {
      warnings.push(`DOMAIN PARSE FAILED: ${(e as Error).message}`);
    }

    let groupIndex = 0;
    for (const group of groups) {
      const groupConds: Prepared["conditions"] = [];
      for (const leaf of group) {
        if (leaf.field === "extra_features_id.value_ids.id") {
          // `=` takes a single id; `in` takes a list, which is an OR within
          // this same group (e.g. economic: value_ids in [108, 110]).
          const ids =
            leaf.op === "in" || leaf.op === "not in"
              ? leaf.value.replace(/[[\]]/g, "").split(",").map((s) => Number(s.trim()))
              : [Number(leaf.value)];

          for (const vid of ids) {
            const v = valueById.get(vid);
            if (!v) {
              // The ops team deleted some attribute values but left the tag
              // domains pointing at them (111 خانه روستایی, 117 هاستل, 295 باغ).
              // In Odoo such a clause matches nothing, so the page is empty —
              // it must NOT degrade into "no filter", which would show every
              // listing on a page titled e.g. "اجاره باغ ویلا".
              warnings.push(`attribute value id ${vid} no longer exists in Odoo — clause matches nothing`);
              unresolvable = true;
              continue;
            }
            if (!v.attr_key) {
              warnings.push(`attribute "${v.attr_name}" has no x_title_en key`);
              unresolvable = true;
              continue;
            }
            // Binary amenities are stored as a link only — "دارد" means "has
            // it", and a "ندارد" link is never written. Categorical attributes
            // (نوع اقامتگاه / منطقه اقامتگاه) keep their value.
            const isPresenceValue = v.value_name.trim() === "دارد";
            const cond = {
              groupIndex,
              amenityKey: amenityKeys.has(v.attr_key) ? v.attr_key : null,
              ruleKey: ruleKeys.has(v.attr_key) ? v.attr_key : null,
              valueName: isPresenceValue ? null : v.value_name.trim(),
            };
            if (!cond.amenityKey && !cond.ruleKey) {
              warnings.push(`key "${v.attr_key}" matches no Amenity or Rule`);
              unresolvable = true;
              continue;
            }
            groupConds.push(cond);
          }
        } else if (leaf.field === "x_week_price") {
          const n = Number(leaf.value);
          if (leaf.op === ">" || leaf.op === ">=") priceMin = n;
          else if (leaf.op === "<" || leaf.op === "<=") priceMax = n;
          else warnings.push(`unhandled price operator ${leaf.op}`);
        } else if (leaf.field === "x_ready") {
          matchIsFast = true;
        } else if (leaf.field === "x_display_type") {
          const v = leaf.value.replace(/['"]/g, "").trim();
          if (v === "boomgardi") residenceType = "BOOMGARDI";
          else if (v === "hotel") residenceType = "HOTEL";
          else if (v === "suit") residenceType = "SUIT";
          else warnings.push(`unknown display type ${v}`);
        } else {
          warnings.push(`unhandled domain field ${leaf.field}`);
        }
      }
      if (groupConds.length) {
        conditions.push(...groupConds);
        groupIndex++;
      }
    }

    // x_price_range ("0-500000") is the same information in a friendlier form.
    if (priceMin === null && priceMax === null && t.x_price_range) {
      const [lo, hi] = t.x_price_range.split("-").map((s) => Number(s.trim()));
      if (Number.isFinite(lo) && lo > 0) priceMin = lo;
      if (Number.isFinite(hi) && hi > 0) priceMax = hi;
    }

    prepared.push({ tag: t, key, conditions, priceMin, priceMax, matchIsFast, residenceType, unresolvable, warnings });
  }

  // ---------- report ----------
  console.log("\n" + "=".repeat(78));
  for (const p of prepared) {
    const groupCount = p.conditions.length ? Math.max(...p.conditions.map((c) => c.groupIndex)) + 1 : 0;
    console.log(`\n[${p.key}]  ${p.tag.x_name ?? ""}`);
    if (p.tag.x_desc) console.log(`   note: ${p.tag.x_desc.replace(/\s+/g, " ").trim()}`);
    console.log(`   raw:  ${(p.tag.x_domain ?? "").replace(/\s+/g, " ").trim()}`);
    const parts: string[] = [];
    for (let g = 0; g < groupCount; g++) {
      const inGroup = p.conditions.filter((c) => c.groupIndex === g);
      const s = inGroup
        .map((c) => `${c.amenityKey ?? c.ruleKey}${c.valueName ? `="${c.valueName}"` : ""}`)
        .join(" OR ");
      parts.push(inGroup.length > 1 ? `(${s})` : s);
    }
    if (p.residenceType) parts.push(`type=${p.residenceType}`);
    if (p.priceMin !== null) parts.push(`price>${p.priceMin}`);
    if (p.priceMax !== null) parts.push(`price<=${p.priceMax}`);
    if (p.matchIsFast) parts.push(`isFast`);
    console.log(`   ==>   ${parts.length ? parts.join("  AND  ") : "(no filter — matches everything)"}`);
    p.warnings.forEach((w) => console.log(`   WARN  ${w}`));
    if (p.unresolvable) console.log(`   ==>   IMPORTED INACTIVE (a clause is unreproducible; matches nothing in Odoo too)`);
  }
  console.log("\n" + "=".repeat(78));

  const totalWarnings = prepared.reduce((n, p) => n + p.warnings.length, 0);
  console.log(`\n${prepared.length} tags prepared, ${totalWarnings} warning(s).`);

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  let created = 0;
  let updated = 0;
  for (const p of prepared) {
    const data = {
      odooId: p.tag.id,
      key: p.key,
      name: p.tag.x_name?.trim() || p.key,
      shortLabel: SHORT_LABELS[p.key] ?? null,
      description: p.tag.x_desc?.trim() || null,
      residenceType: p.residenceType,
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      matchIsFast: p.matchIsFast,
      contentTitle: p.tag.x_content_title?.trim() || null,
      contentHtml:
        p.tag.x_content && !["<p><br></p>", "<p></p>"].includes(p.tag.x_content.trim())
          ? p.tag.x_content.trim()
          : null,
      // A tag whose domain cannot be reproduced is parked, not shipped with a
      // weaker filter — an under-filtered tag page would list everything.
      isActive: !p.unresolvable,
      isSuggested: !!p.tag.x_suggest && !p.unresolvable,
      showInHomepage: !!p.tag.x_show_in_homepage,
      showInShomal: !!p.tag.x_show_in_shomal,
      sortOrder: p.tag.x_sequence ?? 0,
    };

    const existing = await targetPrisma.seoTag.findUnique({ where: { key: p.key } });
    const row = existing
      ? ((await targetPrisma.seoTag.update({ where: { id: existing.id }, data })), existing)
      : await targetPrisma.seoTag.create({ data });
    existing ? updated++ : created++;

    // Conditions are fully replaced — they are derived data, not user edits yet.
    await targetPrisma.seoTagCondition.deleteMany({ where: { tagId: row.id } });
    if (p.conditions.length) {
      await targetPrisma.seoTagCondition.createMany({
        data: p.conditions.map((c) => ({ ...c, tagId: row.id })),
      });
    }
  }

  console.log(`\nCreated ${created}, updated ${updated} tags.`);
  const condCount = await targetPrisma.seoTagCondition.count();
  console.log(`seo_tag_conditions rows: ${condCount}`);
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
