import { Prisma } from "../../generated/prisma/client";
import { prisma } from "@/lib/prisma";

export async function getPopularDestinations() {
  // Cities ranked by number of published residences.
  const cities = await prisma.city.findMany({
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
  const provinces = await prisma.province.findMany({
    include: { cities: { select: { name: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });

  return provinces.map((p) => ({
    id: p.id,
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    cities: p.cities.map((c) => c.name),
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

export async function searchCitiesAndProvinces(query: string) {
  const [cities, provinces, residences] = await Promise.all([
    prisma.city.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
      include: { province: true, _count: { select: { residences: true } } },
      take: 10,
    }),
    prisma.province.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
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
      displayType: r.type === "BOOMGARDI" ? "boomgardi" : "suit",
    })),
  };
}

export interface ResidenceSearchFilters {
  cityId?: number;
  cityName?: string;
  startDate?: string;
  endDate?: string;
  guestsCount?: number;
  roomsCount?: number;
  minPrice?: number;
  maxPrice?: number;
  type?: "BOOMGARDI" | "SUIT";
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
  city: {
    select: {
      id: true,
      name: true,
      province: { select: { id: true, name: true } },
    },
  },
  neighborhood: true,
  images: { select: { url: true }, orderBy: { sortOrder: "asc" as const }, take: 5 },
  rooms: { select: { id: true } },
} satisfies Prisma.ResidenceSelect;

export function toCard(residence: Prisma.ResidenceGetPayload<{ select: typeof RESIDENCE_CARD_SELECT }>) {
  return {
    id: residence.id,
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
    city: residence.city?.name ?? null,
    province: residence.city?.province?.name ?? null,
    neighborhood: residence.neighborhood,
    images: residence.images.map((i: { url: string }) => i.url),
    mainImage: residence.images[0]?.url ?? null,
    roomsCount: residence.rooms.length,
  };
}

const REGION_ALIASES: Record<string, string[]> = {
  shomal: ["مازندران", "گیلان", "گلستان"],
};

// The category tags surfaced as "جستجوهای مرتبط" on search pages — the
// legacy website_tags rows with x_suggest = true, in their original order.
// `tag` is the query-param key (/search/<slug>?<tag>=1), `title` the label.
const SUGGESTED_TAGS: { tag: string; title: string }[] = [
  { tag: "villa", title: "اجاره ویلا" },
  { tag: "pool", title: "اجاره ویلا و سوئیت استخردار" },
  { tag: "luxury", title: "اجاره ویلا و سوئیت لوکس" },
  { tag: "jacuzzi", title: "اجاره ویلا و سوئیت جکوزی دار" },
  { tag: "forest", title: "اجاره ویلا و سوئیت جنگلی" },
  { tag: "mountain", title: "اجاره ویلا و سوئیت کوهستانی" },
  { tag: "beach", title: "اجاره ویلا و سوئیت ساحلی" },
  { tag: "cottage", title: "اجاره کلبه چوبی" },
  { tag: "hotelapartment", title: "اجاره هتل آپارتمان" },
  { tag: "village", title: "اجاره خانه روستایی" },
  { tag: "guesthouse", title: "اجاره مهمان خانه و هاستل" },
  { tag: "economic", title: "اجاره ویلا و سوئیت ارزان" },
  { tag: "apartment", title: "اجاره روزانه خانه و آپارتمان مبله" },
  { tag: "boomgardi", title: "اجاره اقامتگاه بوم گردی" },
];

// SEO page data for /search/<slug> — the new-backend equivalent of legacy
// Odoo's /api/search/new_page_data (meta tags, page H1, guide content block,
// related-search tag links, and template-generated FAQs).
export async function getSearchPageData(slug: string) {
  const q = slug.trim();

  const city = await prisma.city.findFirst({
    where: {
      OR: [{ titleEn: { equals: q, mode: "insensitive" } }, { name: q }],
    },
    include: { province: true },
  });

  const province = city
    ? null
    : await prisma.province.findFirst({
        where: { OR: [{ titleEn: { equals: q, mode: "insensitive" } }, { name: q }] },
      });

  const place = city ?? province;
  const placeName = place?.name ?? "";
  const placeSlug = place?.titleEn ?? q;

  const faqs = placeName
    ? [
        {
          id: 1,
          question: `چطور در ${placeName} اقامتگاه رزرو کنم؟`,
          answer: `کافیه از بین اقامتگاه‌های ${placeName} در همین صفحه، مورد دلخواهتون رو انتخاب کنید، وارد صفحه‌ی اقامتگاه بشید و تاریخ ورود و خروج رو مشخص و درخواست رزرو رو رایگان ثبت کنید. تیم پشتیبانی لیدوماتریپ هم به‌صورت ۲۴ ساعته پاسخگوی شماست.`,
        },
        {
          id: 2,
          question: `قیمت اجاره اقامتگاه در ${placeName} شبی چنده؟`,
          answer: `قیمت بر اساس نوع اقامتگاه، ظرفیت، امکانات و فصل سفر متفاوته. با فیلتر «قیمت برای یک شب» در همین صفحه می‌تونید بازه‌ی قیمتی موردنظرتون رو مشخص کنید و نتایج رو مقایسه کنید.`,
        },
        {
          id: 3,
          question: `آیا رزرو در لیدوماتریپ قطعیه و ضمانت داره؟`,
          answer: `بله — لیدوماتریپ صحت اطلاعات اقامتگاه، تحویل به‌موقع و نظافت رو تضمین می‌کنه و برای هر رزرو فاکتور رسمی صادر می‌شه. در صورت بروز هر مشکلی، پشتیبانی ۲۴ ساعته پیگیری می‌کنه.`,
        },
        {
          id: 4,
          question: `امکان کنسل‌کردن رزرو در ${placeName} هست؟`,
          answer: `بله، طبق سیاست کنسلی هر اقامتگاه (که در صفحه‌ی همون اقامتگاه ذکر شده) می‌تونید رزرو رو لغو کنید. جزئیات کامل در صفحه‌ی «قوانین کنسلی رزرو» سایت اومده.`,
        },
      ]
    : [];

  return {
    city: city ? { name: city.name, title_en: city.titleEn } : null,
    province: city?.province
      ? { name: city.province.name, title_en: city.province.titleEn }
      : province
      ? { name: province.name, title_en: province.titleEn }
      : null,
    cat_name: placeName || null,
    page_title: placeName ? `اجاره ویلا، سوئیت و اقامتگاه در ${placeName}` : null,
    title: place?.metaTitle ?? null,
    description: place?.metaDescription ?? null,
    content_title: place?.contentTitle ?? null,
    content: place?.contentHtml ?? null,
    canonical: place?.titleEn ? `/search/${place.titleEn}` : null,
    related_tags: placeName
      ? SUGGESTED_TAGS.map((t) => ({
          tag: t.tag,
          cat_title: placeSlug,
          cat_name: placeName,
          title: t.title,
        }))
      : SUGGESTED_TAGS.map((t) => ({ tag: t.tag, cat_title: null, cat_name: null, title: t.title })),
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

  if (filters.cityId) where.cityId = filters.cityId;
  if (filters.cityName && REGION_ALIASES[filters.cityName.toLowerCase()]) {
    // Legacy "region" slugs (Odoo x_category_type='region') that don't map to
    // a single city/province. Only shomal is wired up for now — it's linked
    // from the homepage banner and indexed as /search/shomal. The other
    // region slugs (westtehran, southiran, ...) still need real region
    // support if their SEO pages matter.
    where.city = { province: { name: { in: REGION_ALIASES[filters.cityName.toLowerCase()] } } };
  } else if (filters.cityName) {
    // Accepts either the Persian name ("تهران") or the hand-curated English
    // slug ("tehran" — City.titleEn, from Odoo's product_public_category
    // x_title_en, which every old /search/<slug> SEO URL is built on). A
    // province name/slug (e.g. "mazandaran") matches all its cities.
    const q = filters.cityName;
    where.city = {
      OR: [
        { titleEn: { equals: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        {
          province: {
            OR: [
              { titleEn: { equals: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          },
        },
      ],
    };
  }
  if (filters.type) where.type = filters.type;
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

  const orderBy: Prisma.ResidenceOrderByWithRelationInput =
    filters.order === "price_asc"
      ? { weekPrice: "asc" }
      : filters.order === "price_desc"
        ? { weekPrice: "desc" }
        : filters.order === "rating_desc"
          ? { averageRating: "desc" }
          : { createdAt: "desc" };

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
