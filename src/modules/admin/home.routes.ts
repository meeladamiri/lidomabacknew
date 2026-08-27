// Admin routes for the home page CMS. Mounted under /api/admin.
//
// Every write invalidates the public bundle cache, so an edit shows up on the
// next page request instead of waiting out the TTL.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { idParamSchema } from "./admin.schema";
import { prisma } from "@/lib/prisma";
import { invalidateHomeCache } from "@/modules/home/home.service";

const router = Router();

const nullableString = z.union([z.string(), z.null()]).optional();
const nullableNumber = z.union([z.number(), z.null()]).optional();

/** Everything the home screen needs, in one call. */
router.get(
  "/home",
  asyncHandler(async (_req, res) => {
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
      rails,
    ] = await Promise.all([
      prisma.homeSettings.findUnique({ where: { id: 1 } }),
      prisma.homeSection.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeBanner.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeDescSection.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeResidenceType.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeSlider.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeTrustBox.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeArticle.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeSearchSuggestion.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.homeRail.findMany({
        orderBy: { sortOrder: "asc" },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      }),
    ]);
    return ok(res, {
      settings,
      sections,
      banners,
      descSections,
      types,
      sliders,
      trustBoxes,
      articles,
      suggestions,
      rails,
    });
  }),
);

/**
 * The pick-lists the rail editor needs: which cities and tags exist. Without
 * these an editor has to know slugs by heart, and a typo silently produces an
 * empty rail.
 */
router.get(
  "/home/rail-sources",
  asyncHandler(async (_req, res) => {
    const [cities, tags] = await Promise.all([
      prisma.location.findMany({
        where: { isPublished: true, titleEn: { not: null } },
        select: {
          name: true,
          titleEn: true,
          type: true,
          _count: { select: { residences: true } },
        },
        orderBy: [{ residences: { _count: "desc" } }],
        take: 300,
      }),
      prisma.seoTag.findMany({
        where: { isActive: true },
        select: { key: true, name: true },
        orderBy: { key: "asc" },
      }),
    ]);
    return ok(res, {
      cities: cities.map((c) => ({
        slug: c.titleEn,
        name: c.name,
        type: c.type,
        count: c._count.residences,
      })),
      tags: tags.map((t) => ({ slug: t.key, name: t.name || t.key })),
      types: [
        { slug: "VILLA", name: "ویلا" },
        { slug: "SUIT", name: "سوئیت و آپارتمان" },
        { slug: "BOOMGARDI", name: "بوم‌گردی" },
        { slug: "HOTEL", name: "هتل" },
      ],
    });
  }),
);

const railSchema = z.object({
  kind: z.enum(["RESIDENCE", "DESTINATION"]).optional(),
  title: nullableString,
  subtitle: nullableString,
  headingLevel: z.number().int().min(2).max(4).optional(),
  sourceType: z
    .union([
      z.enum(["CITY", "TAG", "TYPE", "FAST", "OFFER", "TOP_RATED", "ALL"]),
      z.null(),
    ])
    .optional(),
  sourceSlug: nullableString,
  take: z.number().int().min(1).max(30).optional(),
  linkTo: nullableString,
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.use("/home/rails", collection(prisma.homeRail, railSchema));

const railItemSchema = z.object({
  railId: z.number().int().optional(),
  title: z.string().min(1).optional(),
  subtitle: nullableString,
  imageUrl: nullableString,
  alt: nullableString,
  link: nullableString,
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.use("/home/rail-items", collection(prisma.homeRailItem, railItemSchema));

router.patch(
  "/home/settings",
  validate(
    z.object({
      body: z.object({
        heroTitle: nullableString,
        heroSubtitle: nullableString,
        heroTitleMobile: nullableString,
        heroSubtitleMobile: nullableString,
        heroImageUrl: nullableString,
        heroImageMobileUrl: nullableString,
        pcTitleColor: nullableString,
        pcSubtitleColor: nullableString,
        pcTitleSize: nullableNumber,
        pcSubtitleSize: nullableNumber,
        mobileTitleColor: nullableString,
        mobileSubtitleColor: nullableString,
        mobileTitleSize: nullableNumber,
        mobileSubtitleSize: nullableNumber,
        searchBackground: nullableString,
        searchBorderColor: nullableString,
        h1: nullableString,
        metaTitle: nullableString,
        metaDescription: nullableString,
        metaKeywords: nullableString,
        appEnabled: z.boolean().optional(),
        appTitle: nullableString,
        appSubtitle: nullableString,
        appImageUrl: nullableString,
        appBazaarUrl: nullableString,
        appMyketUrl: nullableString,
        appSibappUrl: nullableString,
        appDirectUrl: nullableString,
        videoEnabled: z.boolean().optional(),
        videoTitle: nullableString,
        videoDescription: nullableString,
        videoUrl: nullableString,
        videoPosterUrl: nullableString,
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const row = await prisma.homeSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...req.body },
      update: req.body,
    });
    await invalidateHomeCache();
    return ok(res, row);
  }),
);

router.patch(
  "/home/sections/:key",
  validate(
    z.object({
      body: z.object({
        title: nullableString,
        subtitle: nullableString,
        // The page has exactly one H1, so a section heading is H2 or deeper.
        headingLevel: z.number().int().min(2).max(4).optional(),
        isEnabled: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const row = await prisma.homeSection.update({
      where: { key: req.params.key },
      data: req.body,
    });
    await invalidateHomeCache();
    return ok(res, row);
  }),
);

/**
 * The repeating blocks all have the same shape of admin operation, so they
 * share one router factory rather than eight near-identical route blocks.
 */
function collection(model: any, schema: z.ZodTypeAny) {
  const r = Router();
  r.post(
    "/",
    validate(z.object({ body: schema })),
    asyncHandler(async (req, res) => {
      const row = await model.create({ data: req.body });
      await invalidateHomeCache();
      return ok(res, row, 201);
    }),
  );
  r.patch(
    "/:id",
    validate(idParamSchema),
    validate(z.object({ body: schema })),
    asyncHandler(async (req, res) => {
      const row = await model.update({
        where: { id: Number(req.params.id) },
        data: req.body,
      });
      await invalidateHomeCache();
      return ok(res, row);
    }),
  );
  r.delete(
    "/:id",
    validate(idParamSchema),
    asyncHandler(async (req, res) => {
      const row = await model.delete({ where: { id: Number(req.params.id) } });
      await invalidateHomeCache();
      return ok(res, row);
    }),
  );
  return r;
}

const common = {
  alt: nullableString,
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
};

router.use(
  "/home/banners",
  collection(
    prisma.homeBanner,
    z.object({
      name: z.string().min(1).optional(),
      link: nullableString,
      pcImageUrl: nullableString,
      mobileImageUrl: nullableString,
      ...common,
    }),
  ),
);

router.use(
  "/home/desc-sections",
  collection(
    prisma.homeDescSection,
    z.object({
      title: nullableString,
      contentHtml: nullableString,
      videoUrl: nullableString,
      pcImageUrl: nullableString,
      mobileImageUrl: nullableString,
      headingLevel: z.number().int().min(2).max(4).optional(),
      ...common,
    }),
  ),
);

router.use(
  "/home/types",
  collection(
    prisma.homeResidenceType,
    z.object({
      title: z.string().min(1).optional(),
      subtitle: nullableString,
      imageUrl: nullableString,
      link: nullableString,
      showInMobile: z.boolean().optional(),
      ...common,
    }),
  ),
);

router.use(
  "/home/sliders",
  collection(
    prisma.homeSlider,
    z.object({
      title: nullableString,
      imageUrl: nullableString,
      link: nullableString,
      ...common,
    }),
  ),
);

router.use(
  "/home/trust-boxes",
  collection(
    prisma.homeTrustBox,
    z.object({
      title: z.string().min(1).optional(),
      subtitle: nullableString,
      iconUrl: nullableString,
      ...common,
    }),
  ),
);

router.use(
  "/home/articles",
  collection(
    prisma.homeArticle,
    z.object({
      title: z.string().min(1).optional(),
      link: nullableString,
      imageUrl: nullableString,
      authorName: nullableString,
      authorImageUrl: nullableString,
      ...common,
    }),
  ),
);

router.use(
  "/home/suggestions",
  collection(
    prisma.homeSearchSuggestion,
    z.object({
      label: z.string().min(1).optional(),
      href: z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  ),
);

export default router;
