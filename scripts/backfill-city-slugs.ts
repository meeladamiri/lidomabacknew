// One-off backfill: sets `titleEn` (an English URL slug, e.g. for
// /search/<slug> links) on cities that don't have one, via a simple
// Persian -> Latin transliteration. Odoo has no clean English name source
// for cities (checked: neither `product_public_category` nor
// `res_country_state` carry one), so this is a best-effort phonetic
// transliteration, not an authoritative translation — good enough for a
// readable, mostly-unique URL slug. Note the search page itself already
// works fine with the raw Persian city name (it does a `contains` match,
// not an exact-slug lookup), so this is a cosmetic/SEO improvement, not a
// functional fix.
//
// Usage:
//   npx tsx scripts/backfill-city-slugs.ts               # dry run
//   npx tsx scripts/backfill-city-slugs.ts --commit        # writes

import { prisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");

// Ordered longest-match-first so digraphs (e.g. "خ" -> "kh") take priority
// over any single-letter fallback.
const CHAR_MAP: [string, string][] = [
  ["آ", "a"], ["ا", "a"], ["ب", "b"], ["پ", "p"], ["ت", "t"], ["ث", "s"],
  ["ج", "j"], ["چ", "ch"], ["ح", "h"], ["خ", "kh"], ["د", "d"], ["ذ", "z"],
  ["ر", "r"], ["ز", "z"], ["ژ", "zh"], ["س", "s"], ["ش", "sh"], ["ص", "s"],
  ["ض", "z"], ["ط", "t"], ["ظ", "z"], ["ع", "a"], ["غ", "gh"], ["ف", "f"],
  ["ق", "gh"], ["ک", "k"], ["گ", "g"], ["ل", "l"], ["م", "m"], ["ن", "n"],
  ["و", "v"], ["ه", "h"], ["ی", "i"], ["ء", ""], ["ة", "h"], ["ٔ", ""],
  ["‌", "-"], // ZWNJ (half-space) -> hyphen
];

function transliterate(name: string): string {
  let out = "";
  for (const ch of name) {
    const mapped = CHAR_MAP.find(([fa]) => fa === ch);
    out += mapped ? mapped[1] : ch;
  }
  return out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const cities = await prisma.city.findMany({ where: { titleEn: null } });
  console.log(`${cities.length} cities without titleEn.`);

  const used = new Set<string>();
  let updated = 0;
  const samples: string[] = [];

  for (const city of cities) {
    let slug = transliterate(city.name) || `city-${city.id}`;
    // Dedup — a couple of transliterations can collide (e.g. ص/س both -> s).
    if (used.has(slug)) slug = `${slug}-${city.id}`;
    used.add(slug);

    if (samples.length < 10) samples.push(`${city.name} -> ${slug}`);

    if (COMMIT) {
      await prisma.city.update({ where: { id: city.id }, data: { titleEn: slug } });
    }
    updated++;
  }

  console.log("\nSample:");
  samples.forEach((s) => console.log(s));

  if (!COMMIT) console.log(`\nDry run — would update ${updated}. Re-run with --commit to write.`);
  else console.log(`\nDone. Updated ${updated}.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
