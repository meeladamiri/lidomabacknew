import { Prisma } from "../../generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { publicResidenceId } from "@/lib/publicId";
import { RESIDENCE_TYPE_SLUG } from "@/lib/residenceType";
import { resolveLocationBySlug, expandSlugToLocationIds } from "@/lib/location";
import { getActiveSeoTags, findSeoTagByKey, tagToWhere, featureToWhere } from "@/lib/seoTags";
import { getFaqsForPage } from "@/modules/seo/faq.service";
import type { ResidenceType } from "@/generated/prisma/client";

export async function getPopularDestinations() {
  // Cities ranked by number of published residences.
  const cities = await prisma.location.findMany({
    where: { type: "CITY" },
    include: { _count: { select: { residences: true } } },
    orderBy: { residences: { _count: "desc" } },
    take: 12,
  });

  return cities.map((c) => ({
    id: c.id,
    name: c.name,
    titleEn: c.titleEn,
    image: c.imageUrl,
    count: c._count.residences,
    type: "city" as const,
  }));
}

export async function getProvincesAndCities() {
  const provinces = await prisma.location.findMany({
    where: { type: "PROVINCE" },
    include: {
      children: { where: { type: "CITY" }, select: { name: true }, orderBy: { name: "asc" } },
    },
    orderBy: { name: "asc" },
  });

  return provinces.map((p) => ({
    id: p.id,
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    cities: p.children.map((c) => c.name),
  }));
}

// Resolves a legacy Odoo SEO path (e.g. "/tags/villa/اجاره-ویلا-در-آبادان")
// to its 301 target on the new site (populated by
// scripts/migrate-odoo-tag-urls.ts). Paths are stored percent-decoded with no
// trailing slash — normalize the incoming path the same way before lookup.
export async function resolveLegacyRedirect(rawPath: string) {
  let path = rawPath.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed encoding — match as-is */
  }
  path = path.replace(/\/+$/, "");

  const row = await prisma.legacyRedirect.findUnique({ where: { path }, select: { target: true } });
  return row?.target ?? null;
}

// Resolves a legacy Odoo image URL ("/web/image/<model>/<odoo id>/image/…")
// to its migrated object-storage URL (see scripts/migrate-odoo-image-urls.ts).
export async function resolveLegacyImage(model: string, odooId: number) {
  const row = await prisma.legacyImageRedirect.findUnique({
    where: { model_odooId: { model, odooId } },
    select: { url: true },
  });
  return row?.url ?? null;
}

export async function searchCitiesAndProvinces(query: string) {
  const [cities, provinces, residences] = await Promise.all([
    prisma.location.findMany({
      where: { type: { not: "PROVINCE" }, name: { contains: query, mode: "insensitive" } },
      include: { parent: true, _count: { select: { residences: true } } },
      take: 10,
    }),
    prisma.location.findMany({
      where: { type: "PROVINCE", name: { contains: query, mode: "insensitive" } },
      take: 5,
    }),
    // Residence-by-name matches — the destination search box shows these
    // below the city/province suggestions (legacy /api/search_keyword parity).
    prisma.residence.findMany({
      where: {
        state: "PUBLISHED",
        published: true,
        name: { contains: query, mode: "insensitive" },
      },
      select: { id: true, name: true, reference: true, type: true },
      take: 8,
    }),
  ]);

  return {
    cities: cities.map((c) => ({
      id: c.id,
      name: c.name,
      titleEn: c.titleEn,
      count: c._count.residences,
      type: "city" as const,
    })),
    provinces: provinces.map((p) => ({
      id: p.id,
      name: p.name,
      titleEn: p.titleEn,
      type: "province" as const,
    })),
    residences: residences.map((r) => ({
      id: r.id,
      name: r.name,
      reference: r.reference,
      displayType: RESIDENCE_TYPE_SLUG[r.type],
    })),
  };
}

// Feature-key filters (?pool=1, ?villa=1, ?jungle=1, ?smoking=1, ...) are now
// resolved from the database — see lib/seoTags.ts. A curated SEO tag wins; a
// plain Amenity.key or Rule.key still works for the filter-modal checkboxes.
//
// The filter-modal region options (urban/rural/suburb/jungle/desert) are NOT
// SEO tags and map onto values of the "area" attribute. They stay here because
// the modal's keys deliberately differ from the stored Persian values.
const MODAL_AREA_FILTERS: Record<string, string> = {
  urban: "شهری",
  rural: "روستایی",
  suburb: "حومه شهر",
  jungle: "جنگلی",
  desert: "بیابانی",
};

export interface ResidenceSearchFilters {
  cityId?: number;
  cityName?: string;
  features?: string[];
  startDate?: string;
  endDate?: string;
  guestsCount?: number;
  roomsCount?: number;
  minPrice?: number;
  maxPrice?: number;
  type?: ResidenceType;
  mapBounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  page?: number;
  pageSize?: number;
  order?: "price_asc" | "price_desc" | "rating_desc" | "newest";
}

export const RESIDENCE_CARD_SELECT = {
  id: true,
  reference: true,
  name: true,
  name2: true,
  type: true,
  averageRating: true,
  reviewsCount: true,
  isFast: true,
  isFull: true,
  isOffer: true,
  latitude: true,
  longitude: true,
  maxCapacity: true,
  capacity: true,
  weekPrice: true,
  weekendPrice: true,
  location: {
    select: {
      id: true,
      name: true,
      // The card shows "<city>، <province>" — the breadcrumb parent stands in
      // for the old `province` relation.
      parent: { select: { id: true, name: true, type: true } },
    },
  },
  neighborhood: true,
  images: { select: { url: true }, orderBy: { sortOrder: "asc" as const }, take: 5 },
  rooms: { select: { id: true } },
} satisfies Prisma.ResidenceSelect;

export function toCard(residence: Prisma.ResidenceGetPayload<{ select: typeof RESIDENCE_CARD_SELECT }>) {
  return {
    // legacy-URL contract: migrated residences expose their Odoo id (see lib/publicId.ts)
    id: publicResidenceId(residence),
    reference: residence.reference,
    name: residence.name,
    name2: residence.name2,
    type: residence.type,
    averageRating: residence.averageRating,
    reviewsCount: residence.reviewsCount,
    isFast: residence.isFast,
    isFull: residence.isFull,
    isOffer: residence.isOffer,
    latitude: residence.latitude,
    longitude: residence.longitude,
    maxCapacity: residence.maxCapacity,
    capacity: residence.capacity,
    minPrice: residence.weekPrice,
    weekendPrice: residence.weekendPrice,
    city: residence.location?.name ?? null,
    // Only a PROVINCE parent is the province — a city's parent can now be
    // another city or a country.
    province:
      residence.location?.parent?.type === "PROVINCE" ? residence.location.parent.name : null,
    neighborhood: residence.neighborhood,
    images: residence.images.map((i: { url: string }) => i.url),
    mainImage: residence.images[0]?.url ?? null,
    roomsCount: residence.rooms.length,
  };
}

// Public site origin for absolute canonical URLs (matches production).
const SITE_ORIGIN = "https://lidomatrip.com";

// Below this a nightly price is a placeholder rather than a rate. Set by the
// listings team: 8,817 of ~9,571 published listings sit above it, and what is
// underneath is old or unset data rather than a real offer. See the aggregate
// in getSearchPageData.
const MIN_CREDIBLE_PRICE = 300_000;

// SEO page data for /search/<slug> — the new-backend equivalent of legacy
// Odoo's /api/search/new_page_data (meta tags, page H1, guide content block,
// related-search tag links, and template-generated FAQs).
export async function getSearchPageData(slug: string, tags?: string[]) {
  const q = slug.trim();

  const place = await resolveLocationBySlug(q);
  const parent =
    place?.parentId != null
      ? await prisma.location.findUnique({ where: { id: place.parentId } })
      : null;
  // The response keeps the legacy city/province shape the frontend expects.
  const city = place && place.type !== "PROVINCE" ? place : null;
  const province = place?.type === "PROVINCE" ? place : parent?.type === "PROVINCE" ? parent : null;

  const placeName = place?.name ?? "";
  const placeSlug = place?.titleEn ?? q;

  // Same expansion the listing query uses, so the count on the page and the
  // count in the title cannot disagree.
  const placeIds = place ? await expandSlugToLocationIds(placeSlug) : null;

  // Tag×location pages (?pool=1 etc.) carry their own SEO identity. The first
  // recognized tag wins, matching the old behaviour.
  const activeTags = await getActiveSeoTags();
  const tagKey = (tags ?? []).find((t) => activeTags.some((x) => x.key === t)) ?? null;
  const tag = tagKey ? await findSeoTagByKey(tagKey) : null;
  const tagTitle = tag?.name ?? null;
  const tagClauses = tag ? tagToWhere(tag) : [];

  // "سوالات متداول" now come from the faqs table (see modules/seo/faq.service).
  // They used to be four strings built inline here; the seeded rows carry the
  // same text with {location} where the place name was interpolated.
  const faqs = await getFaqsForPage({
    locationId: place?.id ?? null,
    locationName: place?.name ?? null,
    tagId: tag?.id ?? null,
    tagName: tag?.name ?? null,
    kind: "search",
  });

  // The default (no residence type) SEO set for this place. The بوم‌گردی and
  // هتل variants live alongside it and are selected by the type-scoped pages.
  const placeSeo = place
    ? await prisma.locationSeo.findFirst({
        where: { locationId: place.id, residenceType: null },
      })
    : null;

  // The curated page for this exact tag × location, imported from Odoo's
  // tag_url. 9,310 of these carry hand-written meta that used to be discarded
  // in favour of a generated template.
  const tagPage =
    tag && place
      ? await prisma.tagPage.findFirst({
          where: { locationId: place.id, tagId: tag.id, isActive: true },
        })
      : tag
        ? await prisma.tagPage.findFirst({ where: { locationId: null, tagId: tag.id, isActive: true } })
        : null;

  const cityCanonical = place?.titleEn ? `${SITE_ORIGIN}/search/${place.titleEn}` : null;

  let page_title: string | null;
  let title: string | null;
  let description: string | null;
  let canonical: string | null;
  let content_title: string | null;
  let content: string | null;

  if (tagTitle) {
    const core = placeName ? `${tagTitle} در ${placeName}` : tagTitle;
    page_title = core;
    // Prefer what the ops team actually wrote for this page; the template is
    // the fallback for the pages Odoo never had a row for.
    title =
      tagPage?.metaTitle ?? `${core} | تضمین امنیت و نظافت | لیدوما تریپ`;
    description =
      tagPage?.metaDescription ??
      `سایت رسمی ${core} | تضمین امنیت، قیمت و نظافت | پشتیبانی 7/24 | رزرو تلفنی و آنلاین قطعی${
        placeName ? ` در بهترین مناطق ${placeName}` : ""
      }`;
    // Legacy x_canonical was deliberately not imported — it pointed at URLs
    // that themselves 301 (see scripts/migrate-odoo-tag-pages.ts). The
    // canonical is generated against the real destination instead.
    canonical = cityCanonical
      ? `${cityCanonical}?${tagKey}=1`
      : `${SITE_ORIGIN}/search?${tagKey}=1`;
    // Only 22 tag pages have a hand-written body; the rest show none, which is
    // what production did.
    content_title = tagPage?.contentTitle ?? tag?.contentTitle ?? null;
    content = tagPage?.contentHtml ?? tag?.contentHtml ?? null;
  } else {
    page_title = placeSeo?.pageTitle ?? (placeName ? `اجاره ویلا، سوئیت و اقامتگاه در ${placeName}` : null);
    title = placeSeo?.metaTitle ?? null;
    description = placeSeo?.metaDescription ?? null;
    canonical = cityCanonical;
    content_title = placeSeo?.contentTitle ?? null;
    content = placeSeo?.contentHtml ?? null;
  }

  // How many listings this page has, and what the cheapest one costs.
  //
  // Deliberately unfiltered: this is the number that goes in the <title>, and a
  // title that changed with every date or guest filter would be unstable for a
  // crawler — those URLs canonicalise back here anyway. It is the same figure
  // the canonical page shows.
  const statsWhere: Prisma.ResidenceWhereInput = {
    state: "PUBLISHED",
    published: true,
    ...(placeIds?.length ? { locationId: { in: placeIds } } : {}),
    ...(tagClauses.length ? { AND: tagClauses } : {}),
  };

  const [listingCount, priceAgg] = await Promise.all([
    prisma.residence.count({ where: statsWhere }),
    prisma.residence.aggregate({
      // Floor, not `gt: 0`. 75 published listings carry a placeholder price —
      // 43 of them 0 and 19 exactly 1 toman — and without a floor the Shiraz
      // page advertised "from 1 toman" in its title.
      where: { ...statsWhere, weekPrice: { gte: MIN_CREDIBLE_PRICE } },
      _min: { weekPrice: true },
    }),
  ]);

  const minPrice = priceAgg._min.weekPrice ?? null;

  // "جستجوهای مرتبط" — the tags Odoo flagged with x_suggest, in their order.
  const suggested = activeTags
    .filter((t) => t.isSuggested)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  return {
    city: city ? { name: city.name, title_en: city.titleEn } : null,
    province: province ? { name: province.name, title_en: province.titleEn } : null,
    cat_name: placeName || null,
    // For the title and H1 — see the stats block above.
    count: listingCount,
    min_price: minPrice,
    page_title,
    title,
    description,
    // The guide block belongs to the plain location page only — tag pages
    // don't show it (matches production).
    content_title,
    content,
    canonical,
    related_tags: placeName
      ? suggested.map((t) => ({
          tag: t.key,
          cat_title: placeSlug,
          cat_name: placeName,
          title: t.name,
        }))
      : suggested.map((t) => ({ tag: t.key, cat_title: null, cat_name: null, title: t.name })),
    // A tag page used to return no FAQs at all. It now gets whatever is
    // scoped to it — TAG / TAG_LOCATION questions — and the generic search
    // set is filtered out by the placeholder rule when it does not fit.
    faqs,
  };
}

export async function searchResidences(filters: ResidenceSearchFilters) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;

  const where: Prisma.ResidenceWhereInput = {
    state: "PUBLISHED",
    published: true,
  };

  if (filters.cityId) where.locationId = filters.cityId;
  if (filters.cityName) {
    // Accepts either the Persian name ("تهران") or the hand-curated English
    // slug ("tehran" — Location.titleEn, from Odoo's product_public_category
    // x_title_en, which every old /search/<slug> SEO URL is built on).
    const q = filters.cityName;
    // Every location the slug matches, each expanded. A province spans its
    // cities and "شهرهای زیرمجموعه" pull in curated extras (this replaced the
    // hardcoded shomal alias); a slug shared by a city and its province, or by
    // two duplicate city rows, still lists the union the old query produced.
    const ids = await expandSlugToLocationIds(q);
    if (ids) {
      where.locationId = ids.length === 1 ? ids[0] : { in: ids };
    } else {
      // Unresolvable slug: fall back to the old fuzzy name match so a Persian
      // name typed straight into the URL still finds something.
      where.location = {
        OR: [
          { titleEn: { equals: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      };
    }
  }
  if (filters.type) where.type = filters.type;

  // Feature filters (?pool=1, ?villa=1, ?smoking=1, ...). Curated SEO tags
  // resolve to their stored condition groups; plain amenity/rule keys and the
  // filter modal's region options resolve directly. Unknown keys are ignored.
  if (filters.features?.length) {
    const and: Prisma.ResidenceWhereInput[] = [];
    for (const f of filters.features) {
      const tag = await findSeoTagByKey(f);
      if (tag?.isActive) {
        and.push(...tagToWhere(tag));
        continue;
      }
      const area = MODAL_AREA_FILTERS[f];
      if (area) {
        and.push({
          amenities: {
            some: {
              amenity: { key: "area" },
              extraFeatures: { path: ["value"], string_contains: area },
            },
          },
        });
        continue;
      }
      const clause = await featureToWhere(f);
      if (clause) and.push(clause);
    }
    if (and.length) where.AND = and;
  }
  if (filters.guestsCount) where.maxCapacity = { gte: filters.guestsCount };
  if (filters.minPrice || filters.maxPrice) {
    where.weekPrice = {
      ...(filters.minPrice ? { gte: filters.minPrice } : {}),
      ...(filters.maxPrice ? { lte: filters.maxPrice } : {}),
    };
  }
  if (filters.mapBounds) {
    where.latitude = { gte: filters.mapBounds.minLat, lte: filters.mapBounds.maxLat };
    where.longitude = { gte: filters.mapBounds.minLng, lte: filters.mapBounds.maxLng };
  }

  // Availability filter: exclude residences that have a blocking calendar day
  // (at the residence level, i.e. roomId = null) inside the requested range.
  if (filters.startDate && filters.endDate) {
    where.calendarDays = {
      none: {
        roomId: null,
        isBlocked: true,
        date: { gte: new Date(filters.startDate), lt: new Date(filters.endDate) },
      },
    };
  }

  const orderBy: Prisma.ResidenceOrderByWithRelationInput[] =
    filters.order === "price_asc"
      ? [{ weekPrice: "asc" }]
      : filters.order === "price_desc"
        ? [{ weekPrice: "desc" }]
        : filters.order === "rating_desc"
          ? [{ averageRating: "desc" }]
          : filters.order === "newest"
            ? [{ createdAt: "desc" }]
            : // default "پیشنهاد لیدوما": the ops team's manual ranking weight
              // ("اهمیت اقامتگاه" — Residence.importance, migrated from Odoo's
              // x_sequence) first, then rating as the tie-breaker.
              [{ importance: "desc" }, { averageRating: "desc" }, { createdAt: "desc" }];

  const [total, residences] = await Promise.all([
    prisma.residence.count({ where }),
    prisma.residence.findMany({
      where,
      select: RESIDENCE_CARD_SELECT,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    items: residences.map(toCard),
  };
}
