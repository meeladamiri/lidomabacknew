// The four "نوع اقامتگاه" tiles came across from Odoo carrying their old
// absolute links. Two of them 404 on the new site
// (/boomgardi/… and /hotel/…) and one is a 301 hop (/search/city/تهران-164),
// which wastes crawl budget on an internal link. This points them at the live
// targets.
//
// Dry run by default; pass --commit to write.

import { prisma } from "@/lib/prisma";

// Stored links are absolute and percent-encoded, so match on the decoded path.
const FIXES: { match: string; link: string }[] = [
  { match: "/search/city/تهران-164", link: "/search/tehran" },
  { match: "/boomgardi/اجاره-اقامتگاه-بومگردی", link: "/search?boomgardi=1" },
  { match: "/hotel/رزرو-هتل", link: "/search?hotel=1" },
];

function toPath(raw: string | null): string {
  if (!raw) return "";
  let value = raw.trim();
  const onSite = /^https?:\/\/(?:www\.)?lidomatrip\.com(\/.*)?$/i.exec(value);
  if (onSite) value = onSite[1] || "/";
  try {
    value = decodeURIComponent(value);
  } catch {
    /* malformed encoding — compare as-is */
  }
  return value.replace(/\/+$/, "") || "/";
}

(async () => {
  const commit = process.argv.includes("--commit");
  const rows = await prisma.homeResidenceType.findMany({
    select: { id: true, title: true, link: true },
    orderBy: { sortOrder: "asc" },
  });

  for (const row of rows) {
    const path = toPath(row.link);
    const fix = FIXES.find((f) => f.match === path);
    if (!fix) {
      console.log(`  keep   ${row.title}  ->  ${path}`);
      continue;
    }
    console.log(`  fix    ${row.title}  ->  ${path}   =>   ${fix.link}`);
    if (commit) {
      await prisma.homeResidenceType.update({
        where: { id: row.id },
        data: { link: fix.link },
      });
    }
  }

  console.log(commit ? "written" : "dry run — pass --commit to write");
  await prisma.$disconnect();
})();
