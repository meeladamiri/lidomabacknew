// End-to-end parity gate: calls the REAL searchResidences()/getSearchPageData()
// for every legacy slug and compares against the pre-migration snapshot taken
// by verify-location-slugs.ts --snapshot.
//
// verify-location-slugs.ts models the intended semantics in SQL; this proves
// the shipped code actually implements them.
//
// Usage:
//   npx tsx --env-file=.env scripts/verify-search-parity.ts <slugs-before.json>

import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { searchResidences, getSearchPageData } from "@/modules/search/search.service";

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error("pass the slugs-before.json path");

// The snapshot is a map keyed by slug (see verify-location-slugs.ts --snapshot).
interface Snap { slug: string; resolvedKind: string; resolvedName: string | null; residenceCount: number }

async function main() {
  const before: Snap[] = Object.values(JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, Snap>);
  console.log(`Checking ${before.length} slugs against the live search service...\n`);

  // Differences that are deliberate, each with the reason it is correct.
  // Anything NOT listed here is a regression and fails the gate.
  const EXPECTED: Record<string, { count: number; why: string }> = {
    // "شهرهای زیرمجموعه" — Odoo has a location_includes row قزوین -> الموت, so
    // the قزوین page lists الموت's 27 listings too. The snapshot predates the
    // feature being imported at all, hence 48 rather than 75.
    qazvin: { count: 75, why: "location_includes قزوین -> الموت (27) now applied" },
  };

  const failures: string[] = [];
  const intended: string[] = [];
  let checked = 0;

  for (const row of before) {
    const res = await searchResidences({ cityName: row.slug, pageSize: 1 });
    if (res.total !== row.residenceCount) {
      const exp = EXPECTED[row.slug];
      if (exp && exp.count === res.total) {
        intended.push(`${row.slug}: ${row.residenceCount} -> ${res.total}  (${exp.why})`);
      } else {
        failures.push(`COUNT  ${row.slug} — snapshot ${row.residenceCount}, live ${res.total}`);
      }
    }
    // The page must still identify the same place.
    const page = await getSearchPageData(row.slug);
    if ((page.cat_name ?? "") !== (row.resolvedName ?? "")) {
      failures.push(`PLACE  ${row.slug} — snapshot "${row.resolvedName}", live "${page.cat_name ?? ""}"`);
    }
    if (++checked % 100 === 0) process.stdout.write(`  ...${checked}\n`);
  }

  console.log(`\nChecked ${checked} slugs.`);
  if (intended.length) {
    console.log(`
${intended.length} intended difference(s) — each allowlisted with a reason:`);
    intended.forEach((x) => console.log("  " + x));
  }

  if (failures.length === 0) {
    console.log("PASS — the live search service matches the pre-migration snapshot exactly.");
  } else {
    console.log(`FAIL — ${failures.length} difference(s):\n`);
    failures.slice(0, 40).forEach((f) => console.log("  " + f));
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
