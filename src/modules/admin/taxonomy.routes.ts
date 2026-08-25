// Admin routes for the location tree, SEO tags, and curated tag pages.
// Mounted under /api/admin (which already requires an admin session).

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { idParamSchema } from "./admin.schema";
import * as service from "./taxonomy.service";

const router = Router();

const LOCATION_TYPES = ["COUNTRY", "PROVINCE", "CITY", "REGION", "VILLAGE", "NEIGHBORHOOD"] as const;
const RESIDENCE_TYPES = ["SUIT", "BOOMGARDI", "HOTEL"] as const;

const nullableNumber = z.union([z.number(), z.null()]).optional();
const nullableString = z.union([z.string(), z.null()]).optional();

const locationBody = z.object({
  body: z.object({
    type: z.enum(LOCATION_TYPES).optional(),
    name: z.string().min(1).optional(),
    titleEn: nullableString,
    parentId: nullableNumber,
    canonicalId: nullableNumber,
    imageUrl: nullableString,
    latitude: nullableNumber,
    longitude: nullableNumber,
    keywords: nullableString,
    isPublished: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    isActive: z.boolean().optional(),
    popularIndex: nullableNumber,
    shomalIndex: nullableNumber,
    sortOrder: z.number().optional(),
  }),
});

const conditionSchema = z.object({
  groupIndex: z.number().int().min(0).default(0),
  amenityKey: nullableString,
  ruleKey: nullableString,
  valueName: nullableString,
});

const tagBody = z.object({
  body: z.object({
    key: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    shortLabel: nullableString,
    description: nullableString,
    residenceType: z.union([z.enum(RESIDENCE_TYPES), z.null()]).optional(),
    priceMin: nullableNumber,
    priceMax: nullableNumber,
    matchIsFast: z.boolean().optional(),
    contentTitle: nullableString,
    contentHtml: nullableString,
    isActive: z.boolean().optional(),
    isSuggested: z.boolean().optional(),
    showInHomepage: z.boolean().optional(),
    showInShomal: z.boolean().optional(),
    sortOrder: z.number().optional(),
    conditions: z.array(conditionSchema).optional(),
  }),
});

const tagPageBody = z.object({
  body: z.object({
    locationId: nullableNumber,
    tagId: nullableNumber,
    metaTitle: nullableString,
    metaDescription: nullableString,
    metaKeywords: nullableString,
    contentTitle: nullableString,
    contentHtml: nullableString,
    showInSitemap: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }),
});

// ---------- locations ----------

router.get(
  "/locations",
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.listLocations({
        q: req.query.q as string | undefined,
        type: req.query.type as any,
      })
    )
  )
);

router.get(
  "/locations/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await service.getLocation(Number(req.params.id))))
);

router.post(
  "/locations",
  validate(locationBody),
  asyncHandler(async (req, res) => ok(res, await service.createLocation(req.body), 201))
);

router.patch(
  "/locations/:id",
  validate(idParamSchema),
  validate(locationBody),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateLocation(Number(req.params.id), req.body))
  )
);

router.delete(
  "/locations/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await service.deleteLocation(Number(req.params.id))))
);

// "شهرهای زیرمجموعه"
router.put(
  "/locations/:id/includes",
  validate(idParamSchema),
  validate(z.object({ body: z.object({ childIds: z.array(z.number().int()) }) })),
  asyncHandler(async (req, res) =>
    ok(res, await service.setLocationIncludes(Number(req.params.id), req.body.childIds))
  )
);

// One of the three SEO sets; residenceType omitted = the default set.
router.put(
  "/locations/:id/seo",
  validate(idParamSchema),
  validate(
    z.object({
      body: z.object({
        residenceType: z.union([z.enum(RESIDENCE_TYPES), z.null()]).optional(),
        pageTitle: nullableString,
        metaTitle: nullableString,
        metaDescription: nullableString,
        metaKeywords: nullableString,
        contentTitle: nullableString,
        contentHtml: nullableString,
        phone: nullableString,
        showPhone: z.boolean().optional(),
        showPhoneFrom: nullableNumber,
        showPhoneTo: nullableNumber,
        showInHomepage: z.boolean().optional(),
        homepageIndex: nullableNumber,
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.upsertLocationSeo(
        Number(req.params.id),
        req.body.residenceType ?? null,
        req.body
      )
    )
  )
);

// ---------- seo tags ----------

router.get("/seo-tags", asyncHandler(async (_req, res) => ok(res, await service.listSeoTags())));

router.get(
  "/seo-tags/options",
  asyncHandler(async (_req, res) => ok(res, await service.getTagConditionOptions()))
);

router.post(
  "/seo-tags/preview",
  asyncHandler(async (req, res) => ok(res, await service.previewSeoTag(req.body ?? {})))
);

router.get(
  "/seo-tags/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await service.getSeoTag(Number(req.params.id))))
);

router.post(
  "/seo-tags",
  validate(tagBody),
  asyncHandler(async (req, res) => ok(res, await service.createSeoTag(req.body), 201))
);

router.patch(
  "/seo-tags/:id",
  validate(idParamSchema),
  validate(tagBody),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateSeoTag(Number(req.params.id), req.body))
  )
);

router.delete(
  "/seo-tags/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.deleteSeoTag(Number(req.params.id), req.query.force === "true"))
  )
);

// ---------- curated tag pages ----------

router.get(
  "/tag-pages",
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.listTagPages({
        locationId: req.query.locationId ? Number(req.query.locationId) : undefined,
        tagId: req.query.tagId ? Number(req.query.tagId) : undefined,
        q: req.query.q as string | undefined,
        onlyActive: req.query.onlyActive === "true",
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      })
    )
  )
);

router.post(
  "/tag-pages",
  validate(tagPageBody),
  asyncHandler(async (req, res) => ok(res, await service.createTagPage(req.body), 201))
);

router.patch(
  "/tag-pages/:id",
  validate(idParamSchema),
  validate(tagPageBody),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateTagPage(Number(req.params.id), req.body))
  )
);

router.delete(
  "/tag-pages/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await service.deleteTagPage(Number(req.params.id))))
);

export default router;
