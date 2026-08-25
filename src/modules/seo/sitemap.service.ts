// Sitemap + robots.txt generation.
//
// Rule-driven: `sitemap_sections` says which families of URLs belong in the
// sitemap and under what thresholds, and the files are built from live data on
// request. No URL is ever stored.
//
// The one rule that matters more than any other: a URL belongs in the sitemap
// only if it is SELF-CANONICAL and returns 200. Submitting anything that
// redirects, 404s, or points its canonical elsewhere is how a sitemap starts
// hurting instead of helping. Concretely, this file excludes:
//
//   • the ~9,890 legacy /tags/… paths — they 301 to /search (legacy_redirects)
//   • the /web/image/… paths — they 301 to object storage
//   • locations with no slug (no page exists) or unpublished
//   • tag pages whose tag is inactive — verified: /search/shiraz?garden=1
//     canonicalises to /search/shiraz, so listing it would submit a duplicate
//   • anything below the section's thin-content threshold

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { publicResidenceId } from "@/lib/publicId";
import { getSeoTags, tagToWhere } from "@/lib/seoTags";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export type SectionKey = "static" | "locations" | "tag-pages" | "residences" | "hosts";

const SECTION_KEYS: SectionKey[] = ["static", "locations", "tag-pages", "residences", "hosts"];

export async function getSettings() {
  const existing = await prisma.sitemapSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  // The migration seeds row 1; recreate it if a fresh database lacks one.
  return prisma.sitemapSettings.create({ data: { id: 1 } });
}

export async function getSections() {
  return prisma.sitemapSection.findMany({ orderBy: { sortOrder: "asc" } });
}

/** Static, hand-listed pages. These have no database row to drive them. */
const STATIC_PATHS = [
  "/",
  "/search",
  "/about-us",
  "/contact-us",
  "/rules",
  "/faq",
  "/cancellation-rules",
  "/privacy",
];

function abs(siteUrl: string, path: string) {
  return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

function isoDate(d: Date | null | undefined) {
  return (d ?? new Date()).toISOString().slice(0, 10);
}

/**
 * Every URL in a section, before chunking. Ordered deterministically so a
 * given chunk keeps its contents between requests — a crawler that fetched
 * page 2 yesterday should not get a different slice today.
 */
export async function collectSectionUrls(key: SectionKey): Promise<SitemapUrl[]> {
  const [settings, sections] = await Promise.all([getSettings(), getSections()]);
  const section = sections.find((s) => s.key === key);
  if (!section || !section.isEnabled) return [];

  const site = settings.siteUrl;
  const freq = section.changeFreq.toLowerCase();
  const base = { changefreq: freq, priority: section.priority };
  const min = section.minResidenceCount;

  switch (key) {
    case "static":
      return STATIC_PATHS.map((p) => ({ loc: abs(site, p), ...base }));

    case "locations": {
      // A location page exists only when it has a slug; unpublished ones are
      // excluded. `canonicalId` means the place deliberately consolidates onto
      // another page, so it must not be submitted as its own URL.
      const rows = await prisma.location.findMany({
        where: {
          isPublished: true,
          isActive: true,
          canonicalId: null,
          titleEn: { not: null },
        },
        select: {
          titleEn: true,
          updatedAt: true,
          _count: { select: { residences: true } },
        },
        orderBy: { id: "asc" },
      });
      return rows
        .filter((r) => r._count.residences >= min)
        .map((r) => ({
          loc: abs(site, `/search/${r.titleEn}`),
          ...(section.includeLastmod ? { lastmod: isoDate(r.updatedAt) } : {}),
          ...base,
        }));
    }

    case "tag-pages": {
      // Only pages whose tag is ACTIVE: an inactive tag is not applied as a
      // filter, so its URL renders the plain location page and canonicalises
      // there — submitting it would be submitting a duplicate.
      const rows = await prisma.tagPage.findMany({
        where: {
          isActive: true,
          ...(section.requireSitemapFlag ? { showInSitemap: true } : {}),
          tag: { isActive: true },
        },
        select: {
          updatedAt: true,
          locationId: true,
          location: { select: { titleEn: true, isPublished: true, canonicalId: true } },
          tag: { select: { id: true, key: true } },
        },
        orderBy: { id: "asc" },
      });

      const eligible = rows.filter(
        (r) =>
          r.tag &&
          (!r.location || (r.location.isPublished && !r.location.canonicalId && r.location.titleEn))
      );

      // Thin-content gate. TagPage.residenceCount is Odoo's cached number and
      // is years stale (3,900 rows sit at 0), so it is recomputed here from
      // live data instead: one grouped query per active tag, not one per page.
      const counts = min > 0 ? await countListingsPerTagLocation(eligible) : null;

      return eligible
        .filter((r) => {
          if (!counts) return true;
          return (counts.get(`${r.tag!.id}|${r.locationId ?? "null"}`) ?? 0) >= min;
        })
        .map((r) => ({
          // A row with no location is the nationwide "تگ مادر".
          loc: r.location
            ? abs(site, `/search/${r.location.titleEn}?${r.tag!.key}=1`)
            : abs(site, `/search?${r.tag!.key}=1`),
          ...(section.includeLastmod ? { lastmod: isoDate(r.updatedAt) } : {}),
          ...base,
        }));
    }

    case "residences": {
      const rows = await prisma.residence.findMany({
        where: { state: "PUBLISHED", published: true },
        select: { id: true, reference: true, updatedAt: true },
        orderBy: { id: "asc" },
      });
      return rows.map((r) => ({
        // legacy-URL contract: migrated listings expose their Odoo id
        loc: abs(site, `/rentals/${publicResidenceId(r)}`),
        ...(section.includeLastmod ? { lastmod: isoDate(r.updatedAt) } : {}),
        ...base,
      }));
    }

    case "hosts": {
      const rows = await prisma.user.findMany({
        where: {
          isHost: true,
          isActive: true,
          residences: { some: { state: "PUBLISHED", published: true } },
        },
        select: {
          id: true,
          updatedAt: true,
          _count: { select: { residences: true } },
        },
        orderBy: { id: "asc" },
      });
      return rows
        .filter((r) => r._count.residences >= min)
        .map((r) => ({
          loc: abs(site, `/host/${r.id}`),
          ...(section.includeLastmod ? { lastmod: isoDate(r.updatedAt) } : {}),
          ...base,
        }));
    }
  }
}

/**
 * Live listing counts keyed by "<tagId>|<locationId|null>".
 *
 * One grouped query per distinct tag (about 15), not one per tag page (4,597).
 * The nationwide "تگ مادر" rows get the tag's total.
 *
 * Deliberately ignores LocationInclude expansion, so a page like
 * /search/qazvin?pool=1 is counted on قزوین's own listings and not الموت's.
 * That undercounts, which is the safe direction for a thin-content gate: it can
 * withhold a borderline page, never submit an empty one.
 */
async function countListingsPerTagLocation(
  rows: { locationId: number | null; tag: { id: number } | null }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const tagIds = [...new Set(rows.map((r) => r.tag?.id).filter((x): x is number => !!x))];
  if (!tagIds.length) return out;

  const tags = await getSeoTags();

  for (const tagId of tagIds) {
    const tag = tags.find((t) => t.id === tagId);
    if (!tag) continue;
    const clauses = tagToWhere(tag);
    const where: Prisma.ResidenceWhereInput = {
      state: "PUBLISHED",
      published: true,
      ...(clauses.length ? { AND: clauses } : {}),
    };

    const grouped = await prisma.residence.groupBy({
      by: ["locationId"],
      where,
      _count: { _all: true },
    });

    let total = 0;
    for (const g of grouped) {
      total += g._count._all;
      if (g.locationId != null) out.set(`${tagId}|${g.locationId}`, g._count._all);
    }
    out.set(`${tagId}|null`, total);
  }

  return out;
}

/** Section key + chunk count, used to build the sitemap index. */
export async function getIndexEntries() {
  const settings = await getSettings();
  const sections = await getSections();
  const entries: { key: string; label: string; page: number; count: number }[] = [];

  for (const s of sections) {
    if (!s.isEnabled) continue;
    if (!SECTION_KEYS.includes(s.key as SectionKey)) continue;
    const urls = await collectSectionUrls(s.key as SectionKey);
    if (urls.length === 0) continue;
    const per = Math.max(1, settings.maxUrlsPerFile);
    const pages = Math.ceil(urls.length / per);
    for (let p = 1; p <= pages; p++) {
      entries.push({
        key: s.key,
        label: s.label,
        page: p,
        count: Math.min(per, urls.length - (p - 1) * per),
      });
    }
  }
  return entries;
}

export async function getSectionPage(key: SectionKey, page: number) {
  const settings = await getSettings();
  const urls = await collectSectionUrls(key);
  const per = Math.max(1, settings.maxUrlsPerFile);
  return urls.slice((page - 1) * per, page * per);
}

// ---------------------------------------------------------------- rendering

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderUrlSet(urls: SitemapUrl[]) {
  const body = urls
    .map((u) => {
      const parts = [`    <loc>${escapeXml(u.loc)}</loc>`];
      if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
      if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority !== undefined) parts.push(`    <priority>${u.priority.toFixed(1)}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export async function renderIndex() {
  const settings = await getSettings();
  const entries = await getIndexEntries();
  const today = isoDate(new Date());
  const body = entries
    .map((e) => {
      const loc = abs(settings.siteUrl, `/sitemaps/${e.key}-${e.page}.xml`);
      return `  <sitemap>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

export async function renderRobots() {
  const settings = await getSettings();

  if (!settings.robotsEnabled) return "";

  // Master switch: the pre-launch / staging posture. Kept deliberately blunt —
  // one line, no sitemap reference, nothing a crawler could act on.
  if (!settings.allowIndexing) {
    return "User-agent: *\nDisallow: /\n";
  }

  const rules = await prisma.robotsRule.findMany({
    where: { isActive: true },
    orderBy: [{ userAgent: "asc" }, { sortOrder: "asc" }],
  });

  const byAgent = new Map<string, typeof rules>();
  for (const r of rules) {
    if (!byAgent.has(r.userAgent)) byAgent.set(r.userAgent, []);
    byAgent.get(r.userAgent)!.push(r);
  }
  // "*" first, which is what every robots.txt convention expects.
  const agents = [...byAgent.keys()].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));

  const blocks: string[] = [];
  for (const agent of agents) {
    const lines = [`User-agent: ${agent}`];
    for (const r of byAgent.get(agent)!) {
      lines.push(`${r.directive}: ${r.path}`);
    }
    if (settings.crawlDelay && agent === "*") lines.push(`Crawl-delay: ${settings.crawlDelay}`);
    blocks.push(lines.join("\n"));
  }

  if (blocks.length === 0) blocks.push("User-agent: *\nDisallow:");

  let out = blocks.join("\n\n");

  if (settings.robotsExtra?.trim()) out += `\n\n${settings.robotsExtra.trim()}`;

  if (settings.sitemapEnabled) {
    out += `\n\nSitemap: ${abs(settings.siteUrl, "/sitemap.xml")}\n`;
  } else {
    out += "\n";
  }

  return out;
}

// ---------------------------------------------------------------- admin view

/**
 * Counts per section plus the reasons URLs were withheld, so the admin screen
 * can explain the number instead of just showing it.
 */
export async function getSitemapStats() {
  const [settings, sections] = await Promise.all([getSettings(), getSections()]);

  const stats: {
    key: string;
    label: string;
    isEnabled: boolean;
    included: number;
    excluded: { reason: string; count: number }[];
  }[] = [];

  for (const s of sections) {
    const key = s.key as SectionKey;
    if (!SECTION_KEYS.includes(key)) continue;
    const included = s.isEnabled ? (await collectSectionUrls(key)).length : 0;
    const excluded: { reason: string; count: number }[] = [];

    if (key === "locations") {
      const [noSlug, unpublished, canonicalised, thin] = await Promise.all([
        prisma.location.count({ where: { titleEn: null } }),
        prisma.location.count({ where: { titleEn: { not: null }, OR: [{ isPublished: false }, { isActive: false }] } }),
        prisma.location.count({ where: { titleEn: { not: null }, canonicalId: { not: null } } }),
        prisma.location.count({
          where: {
            titleEn: { not: null },
            isPublished: true,
            isActive: true,
            canonicalId: null,
            residences: { none: {} },
          },
        }),
      ]);
      excluded.push(
        { reason: "بدون اسلاگ انگلیسی (صفحه‌ای ندارن)", count: noSlug },
        { reason: "منتشرنشده یا غیرفعال", count: unpublished },
        { reason: "canonical به مکان دیگه", count: canonicalised },
        { reason: `کمتر از ${s.minResidenceCount} اقامتگاه`, count: s.minResidenceCount > 0 ? thin : 0 }
      );
    }

    if (key === "tag-pages") {
      const [notFlagged, inactive, inactiveTag] = await Promise.all([
        prisma.tagPage.count({ where: { showInSitemap: false } }),
        prisma.tagPage.count({ where: { showInSitemap: true, isActive: false } }),
        prisma.tagPage.count({ where: { showInSitemap: true, isActive: true, tag: { isActive: false } } }),
      ]);
      excluded.push(
        { reason: "فلگ «نمایش در sitemap» ندارن", count: notFlagged },
        { reason: "صفحه غیرفعاله", count: inactive },
        { reason: "تگش غیرفعاله (canonical به صفحه‌ی شهر می‌خوره)", count: inactiveTag }
      );
    }

    stats.push({
      key: s.key,
      label: s.label,
      isEnabled: s.isEnabled,
      included,
      excluded: excluded.filter((e) => e.count > 0),
    });
  }

  const total = stats.reduce((n, s) => n + s.included, 0);
  return { settings, sections, stats, total };
}

// ---------------------------------------------------------------- admin writes

export async function updateSettings(data: any) {
  const patch: Record<string, unknown> = {};
  for (const f of [
    "siteUrl", "allowIndexing", "sitemapEnabled", "robotsEnabled",
    "maxUrlsPerFile", "robotsExtra", "crawlDelay",
  ] as const) {
    if (data[f] !== undefined) patch[f] = data[f];
  }
  await getSettings(); // ensure the row exists
  return prisma.sitemapSettings.update({ where: { id: 1 }, data: patch });
}

export async function updateSection(id: number, data: any) {
  const patch: Record<string, unknown> = {};
  for (const f of [
    "isEnabled", "changeFreq", "priority", "minResidenceCount", "includeLastmod",
    "requireSitemapFlag", "sortOrder",
  ] as const) {
    if (data[f] !== undefined) patch[f] = data[f];
  }
  return prisma.sitemapSection.update({ where: { id }, data: patch });
}

export const robotsRules = {
  list: () => prisma.robotsRule.findMany({ orderBy: [{ userAgent: "asc" }, { sortOrder: "asc" }] }),
  create: (data: any) =>
    prisma.robotsRule.create({
      data: {
        userAgent: data.userAgent?.trim() || "*",
        directive: data.directive === "Allow" ? "Allow" : "Disallow",
        path: data.path.trim(),
        note: data.note?.trim() || null,
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
      },
    }),
  update: (id: number, data: any) =>
    prisma.robotsRule.update({
      where: { id },
      data: {
        ...(data.userAgent !== undefined ? { userAgent: data.userAgent?.trim() || "*" } : {}),
        ...(data.directive !== undefined
          ? { directive: data.directive === "Allow" ? "Allow" : "Disallow" }
          : {}),
        ...(data.path !== undefined ? { path: data.path.trim() } : {}),
        ...(data.note !== undefined ? { note: data.note?.trim() || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
    }),
  remove: (id: number) => prisma.robotsRule.delete({ where: { id } }),
};
