// Home page bundle.
//
// The response keeps the legacy Odoo shape (`{ status, params: {...} }` with
// snake_case keys) because every component under front/components/Home already
// reads it — the CMS moved, the contract did not.
//
// One endpoint returns the whole page. The old site made five separate calls
// (get_items + four slider calls), which on a cold load meant five sequential
// round trips before anything below the hero could render.

import { prisma } from "@/lib/prisma";
import { RESIDENCE_CARD_SELECT, toCard } from "@/modules/search/search.service";
import { getFaqsForPage } from "@/modules/seo/faq.service";
import { getSeoTags, tagToWhere } from "@/lib/seoTags";
import { expandSlugToLocationIds } from "@/lib/location";
import type { Prisma } from "@prisma/client";
import { cached, dropKeys, TTL } from "@/lib/cache";

const SITE_ORIGIN = "https://lidomatrip.com";

// The bundle changes only when an admin edits it or a listing is published.
// The cache is shared (Redis), not per-process: with more than one instance
// running, a module-level copy meant each warmed separately and an admin edit
// cleared only whichever one happened to serve the write.
const CACHE_KEY = "home:page";

export function invalidateHomeCache() {
  return dropKeys(CACHE_KEY);
}

const PUBLISHED: Prisma.ResidenceWhereInput = {
  state: "PUBLISHED",
  published: true,
};

/**
 * Turns a curated link into the URL it actually resolves to.
 *
 * Odoo stored absolute links to the OLD url scheme — /tags/villa/…,
 * /search/city/تهران-164, /boomgardi/… — every one of which 301s today. Linking
 * internally to a redirect wastes crawl budget and dilutes the signal, so each
 * link is resolved through legacy_redirects to its final target before it is
 * handed to the page. This fixes an old SEO mistake rather than reproducing it.
 */
async function resolveInternalLink(raw: string | null): Promise<string | null> {
  if (!raw) return null;
  let link = raw.trim();
  if (!link) return null;

  // tel:/mailto: and third-party links pass through untouched.
  if (/^(tel:|mailto:)/i.test(link)) return link;

  let path = link;
  const m = /^https?:\/\/(?:www\.)?lidomatrip\.com(\/.*)?$/i.exec(link);
  if (m) path = m[1] || "/";
  else if (/^https?:\/\//i.test(link)) return link; // genuinely external

  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed encoding — match as-is */
  }
  const normalized = path.replace(/\/+$/, "") || "/";

  const hit = await prisma.legacyRedirect.findUnique({
    where: { path: normalized },
    select: { target: true },
  });
  return hit?.target ?? path;
}

/** A rail of listing cards. */
async function rail(
  where: Prisma.ResidenceWhereInput,
  take: number,
  orderBy?: Prisma.ResidenceOrderByWithRelationInput[],
) {
  const rows = await prisma.residence.findMany({
    where: { ...PUBLISHED, ...where },
    select: RESIDENCE_CARD_SELECT,
    orderBy: orderBy ?? [{ importance: "desc" }, { averageRating: "desc" }],
    take,
  });
  return rows.map(toCard);
}

/** Listings matching a curated SEO tag, so a rail and its tag page agree. */
async function railByTag(key: string, take: number) {
  const tag = (await getSeoTags()).find((t) => t.key === key && t.isActive);
  if (!tag) return [];
  const clauses = tagToWhere(tag);
  return rail(clauses.length ? { AND: clauses } : {}, take);
}

/**
 * Turns a configured rail's source into the listings it shows.
 *
 * Everything falls through to `rail()`, whose default ordering is
 * `importance desc` — the listing priority the team already maintains — so a
 * rail always leads with the same listings the rest of the site prioritises.
 */
async function residencesForSource(
  sourceType: string | null,
  sourceSlug: string | null,
  take: number,
) {
  switch (sourceType) {
    case "CITY": {
      if (!sourceSlug) return [];
      // Expands through location_includes, so "شمال" picks up its sub-cities.
      const ids = await expandSlugToLocationIds(sourceSlug);
      return ids?.length ? rail({ locationId: { in: ids } }, take) : [];
    }
    case "TAG":
      return sourceSlug ? railByTag(sourceSlug, take) : [];
    case "TYPE":
      return sourceSlug ? rail({ type: sourceSlug as any }, take) : [];
    case "FAST":
      return rail({ isFast: true }, take);
    case "OFFER":
      return rail({ isOffer: true }, take);
    case "TOP_RATED":
      return rail({ reviewsCount: { gt: 0 } }, take, [
        { averageRating: "desc" },
        { reviewsCount: "desc" },
      ]);
    case "ALL":
      return rail({}, take);
    default:
      return [];
  }
}

/** The "مشاهده همه" target when the editor has not set one explicitly. */
function defaultRailLink(sourceType: string | null, sourceSlug: string | null) {
  if (!sourceSlug) {
    if (sourceType === "FAST") return "/search?fast=1";
    if (sourceType === "OFFER") return "/search?discounted=true";
    return "/search";
  }
  if (sourceType === "CITY") return `/search/${sourceSlug}`;
  if (sourceType === "TAG") return `/search?${sourceSlug}=1`;
  if (sourceType === "TYPE") return `/search?${sourceSlug.toLowerCase()}=1`;
  return "/search";
}

/** The admin-configured sliders, resolved to what the page renders. */
async function buildRails() {
  const rows = await prisma.homeRail.findMany({
    where: { isEnabled: true },
    orderBy: { sortOrder: "asc" },
    include: {
      items: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
    },
  });

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      subtitle: r.subtitle,
      heading_level: r.headingLevel,
      link_to:
        (await resolveInternalLink(r.linkTo)) ??
        (r.kind === "RESIDENCE"
          ? defaultRailLink(r.sourceType, r.sourceSlug)
          : null),
      residences:
        r.kind === "RESIDENCE"
          ? await residencesForSource(r.sourceType, r.sourceSlug, r.take)
          : [],
      items:
        r.kind === "DESTINATION"
          ? await Promise.all(
              r.items.map(async (i) => ({
                id: i.id,
                title: i.title,
                subtitle: i.subtitle,
                image: i.imageUrl,
                alt: i.alt ?? i.title,
                link: await resolveInternalLink(i.link),
              })),
            )
          : [],
    })),
  );
}

export async function getHomePageData() {
  return cached(CACHE_KEY, TTL.home, buildHomePageData);
}

async function buildHomePageData() {
  const [
    settings,
    sections,
    banners,
    descSections,
    types,
    sliders,
    trustBoxes,
    articles,
    suggestions,
  ] = await Promise.all([
    prisma.homeSettings.findUnique({ where: { id: 1 } }),
    prisma.homeSection.findMany({
      where: { isEnabled: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeBanner.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeDescSection.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeResidenceType.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeSlider.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeTrustBox.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeArticle.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.homeSearchSuggestion.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const [
    selected,
    taste,
    fast,
    discounted,
    boomgardi,
    hotels,
    economical,
    populars,
    faqs,
  ] = await Promise.all([
    rail({ reviewsCount: { gt: 0 } }, 15, [
      { averageRating: "desc" },
      { reviewsCount: "desc" },
    ]),
    rail({}, 15),
    rail({ isFast: true }, 15),
    rail({ isOffer: true }, 15),
    rail({ type: "BOOMGARDI" }, 15),
    rail({ type: "HOTEL" }, 15),
    railByTag("economic", 15),
    // "مقصدهای محبوب" — cities, not listings.
    prisma.location.findMany({
      where: { type: "CITY", isPublished: true, titleEn: { not: null } },
      select: {
        id: true,
        name: true,
        titleEn: true,
        imageUrl: true,
        _count: { select: { residences: true } },
      },
      orderBy: { residences: { _count: "desc" } },
      take: 12,
    }),
    getFaqsForPage({ kind: "page", path: "/" }),
  ]);

  // The two city rails the page shows by name. They used to call an Odoo
  // endpoint with hardcoded category ids; resolving by slug means they follow
  // the location tree (شمال expands through location_includes) instead.
  const [shomalIds, tehranIds] = await Promise.all([
    expandSlugToLocationIds("shomal"),
    expandSlugToLocationIds("tehran"),
  ]);
  const [shomalReses, tehranReses, rails] = await Promise.all([
    shomalIds?.length ? rail({ locationId: { in: shomalIds } }, 15) : [],
    tehranIds?.length ? rail({ locationId: { in: tehranIds } }, 15) : [],
    buildRails(),
  ]);

  const sectionMap = Object.fromEntries(
    sections.map((s) => [
      s.key,
      { title: s.title, subtitle: s.subtitle, heading_level: s.headingLevel },
    ]),
  );

  const data = {
    // ---- SEO / hero ----
    seo: {
      h1: settings?.h1 ?? settings?.heroTitle ?? null,
      title: settings?.metaTitle ?? null,
      description: settings?.metaDescription ?? null,
      keywords: settings?.metaKeywords ?? null,
      canonical: SITE_ORIGIN + "/",
    },
    hero: {
      title: settings?.heroTitle ?? null,
      subtitle: settings?.heroSubtitle ?? null,
      title_mobile: settings?.heroTitleMobile ?? null,
      subtitle_mobile: settings?.heroSubtitleMobile ?? null,
      image: settings?.heroImageUrl ?? null,
      mobile_image: settings?.heroImageMobileUrl ?? null,
      pc_title_color: settings?.pcTitleColor ?? null,
      pc_subtitle_color: settings?.pcSubtitleColor ?? null,
      pc_title_size: settings?.pcTitleSize ?? null,
      pc_subtitle_size: settings?.pcSubtitleSize ?? null,
      mobile_title_color: settings?.mobileTitleColor ?? null,
      mobile_subtitle_color: settings?.mobileSubtitleColor ?? null,
      mobile_title_size: settings?.mobileTitleSize ?? null,
      mobile_subtitle_size: settings?.mobileSubtitleSize ?? null,
      search_background: settings?.searchBackground ?? null,
      search_border_color: settings?.searchBorderColor ?? null,
    },

    sections: sectionMap,

    // ---- curated blocks ----
    // `slides` is what the hero component reads; the seasonal sliders double as
    // its slides, which is how the old page worked.
    slides: await Promise.all(
      sliders.map(async (s) => ({
        id: s.id,
        title: s.title,
        image: s.imageUrl,
        alt: s.alt ?? s.title,
        link: await resolveInternalLink(s.link),
      })),
    ),
    banners: await Promise.all(
      banners.map(async (b) => ({
        id: b.id,
        name: b.name,
        link: await resolveInternalLink(b.link),
        pc_image: b.pcImageUrl,
        mobile_image: b.mobileImageUrl,
        alt: b.alt ?? b.name,
      })),
    ),
    res_types: await Promise.all(
      types.map(async (t) => ({
        id: t.id,
        title: t.title,
        subtitle: t.subtitle,
        image: t.imageUrl,
        alt: t.alt ?? t.title,
        link: await resolveInternalLink(t.link),
        show_in_mobile: t.showInMobile,
      })),
    ),
    desc_boxes: descSections.map((d) => ({
      id: d.id,
      title: d.title,
      content: d.contentHtml,
      video: d.videoUrl,
      pc_image: d.pcImageUrl,
      mobile_image: d.mobileImageUrl,
      alt: d.alt ?? d.title,
      heading_level: d.headingLevel,
    })),
    service_boxes: trustBoxes.map((b) => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      image: b.iconUrl,
      alt: b.alt ?? b.title,
    })),
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      link: a.link,
      image: a.imageUrl,
      alt: a.alt ?? a.title,
      author_name: a.authorName,
      author_image: a.authorImageUrl,
    })),
    search_suggestions: suggestions.map((s) => ({
      id: s.id,
      label: s.label,
      href: s.href,
    })),

    app: settings?.appEnabled
      ? {
          title: settings.appTitle,
          subtitle: settings.appSubtitle,
          image: settings.appImageUrl,
          bazaar: settings.appBazaarUrl,
          myket: settings.appMyketUrl,
          sibapp: settings.appSibappUrl,
          direct: settings.appDirectUrl,
        }
      : null,
    video: settings?.videoEnabled
      ? {
          title: settings.videoTitle,
          description: settings.videoDescription,
          url: settings.videoUrl,
          poster: settings.videoPosterUrl,
        }
      : null,

    // ---- listing rails (legacy key names) ----
    // "پیشنهادات فصل" is a destination slider, not a listing rail: it is the
    // three curated x_homepage_sliders rows.
    suggests: await Promise.all(
      sliders.map(async (s) => ({
        id: s.id,
        name: s.title,
        content: null as string | null,
        image: s.imageUrl,
        alt: s.alt ?? s.title,
        link: await resolveInternalLink(s.link),
      })),
    ),
    selected_reses: selected,
    populars: populars.map((c) => ({
      id: c.id,
      name: c.name,
      title_en: c.titleEn,
      image: c.imageUrl,
      count: c._count.residences,
      link: `/search/${c.titleEn}`,
    })),
    your_taste: taste,
    last_time_offers: discounted,
    discounted_reses: discounted,
    boomgardi_reses: boomgardi,
    hotel_reses: hotels,
    fast_reses: fast,
    shomal_reses: shomalReses,
    tehran_reses: tehranReses,
    economical_reses: economical,

    // Admin-configured sliders. The three legacy keys above stay for now so a
    // half-configured panel cannot blank the page.
    rails,

    faqs,
  };

  return data;
}
