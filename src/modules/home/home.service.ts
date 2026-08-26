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
import type { Prisma } from "@/generated/prisma/client";

const SITE_ORIGIN = "https://lidomatrip.com";

// The bundle changes only when an admin edits it or a listing is published.
const TTL_MS = 60_000;
let cache: { at: number; data: any } | null = null;

export function invalidateHomeCache() {
  cache = null;
}

const PUBLISHED: Prisma.ResidenceWhereInput = { state: "PUBLISHED", published: true };

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
async function rail(where: Prisma.ResidenceWhereInput, take: number, orderBy?: Prisma.ResidenceOrderByWithRelationInput[]) {
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

export async function getHomePageData() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

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
    prisma.homeSection.findMany({ where: { isEnabled: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeBanner.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeDescSection.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeResidenceType.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeSlider.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeTrustBox.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeArticle.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.homeSearchSuggestion.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  const [selected, taste, fast, discounted, boomgardi, hotels, economical, populars, faqs] =
    await Promise.all([
      rail({ reviewsCount: { gt: 0 } }, 15, [{ averageRating: "desc" }, { reviewsCount: "desc" }]),
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

  const sectionMap = Object.fromEntries(
    sections.map((s) => [
      s.key,
      { title: s.title, subtitle: s.subtitle, heading_level: s.headingLevel },
    ])
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
      }))
    ),
    banners: await Promise.all(
      banners.map(async (b) => ({
        id: b.id,
        name: b.name,
        link: await resolveInternalLink(b.link),
        pc_image: b.pcImageUrl,
        mobile_image: b.mobileImageUrl,
        alt: b.alt ?? b.name,
      }))
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
      }))
    ),
    desc_boxes: descSections.map((d) => ({
      id: d.id,
      title: d.title,
      content: d.contentHtml,
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
    search_suggestions: suggestions.map((s) => ({ id: s.id, label: s.label, href: s.href })),

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
      }))
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
    economical_reses: economical,

    faqs,
  };

  cache = { at: Date.now(), data };
  return data;
}
