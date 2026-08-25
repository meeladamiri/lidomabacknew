// Coverage gate for the sitemap: every published listing and every eligible
// location page must appear exactly once across all advertised files.
//
// The per-city restructure moves listings between files, so this guards the
// thing that would otherwise fail silently — a listing that belongs to no file
// at all, or one emitted twice.
//
// Usage: npx tsx --env-file=.env scripts/verify-sitemap-coverage.ts

import { prisma } from "@/lib/prisma";
import { getIndexEntries, getFileUrls } from "@/modules/seo/sitemap.service";

async function main() {
  const entries = await getIndexEntries();
  console.log(`Index advertises ${entries.length} files.`);

  const seen = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    const urls = (await getFileUrls(e.file)) ?? [];
    for (const u of urls) {
      seen.set(u.loc, (seen.get(u.loc) ?? 0) + 1);
      total++;
    }
  }
  console.log(`Collected ${total} URLs (${seen.size} distinct).`);

  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  // The images section deliberately repeats /rentals/<id> to attach the
  // gallery, so a listing appearing twice site-wide is expected there.
  const rentalDupes = dupes.filter(([u]) => u.includes("/rentals/"));
  const otherDupes = dupes.filter(([u]) => !u.includes("/rentals/"));

  const publishedIds = await prisma.residence.findMany({
    where: { state: "PUBLISHED", published: true },
    select: { id: true, reference: true },
  });
  const { publicResidenceId } = await import("@/lib/publicId");
  const expected = new Set(publishedIds.map((r) => `/rentals/${publicResidenceId(r)}`));

  const present = new Set(
    [...seen.keys()].filter((u) => u.includes("/rentals/")).map((u) => u.replace(/^https?:\/\/[^/]+/, ""))
  );
  const missing = [...expected].filter((p) => !present.has(p));

  console.log(`\nPublished listings: ${expected.size}`);
  console.log(`Listings present in sitemap: ${present.size}`);
  console.log(`Missing: ${missing.length}`);
  console.log(`Duplicate non-listing URLs: ${otherDupes.length}`);
  console.log(`Listings also carried by the image sitemap: ${rentalDupes.length} (expected)`);

  if (missing.length) {
    console.log("\nFAIL — these listings are in no sitemap file:");
    missing.slice(0, 15).forEach((m) => console.log("  " + m));
    process.exitCode = 1;
  } else if (otherDupes.length) {
    console.log("\nFAIL — these URLs appear in more than one file:");
    otherDupes.slice(0, 15).forEach(([u, n]) => console.log(`  ${u} (${n}x)`));
    process.exitCode = 1;
  } else {
    console.log("\nPASS — every published listing appears, and nothing is duplicated.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
