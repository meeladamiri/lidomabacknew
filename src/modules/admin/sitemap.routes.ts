// Admin routes for sitemap + robots.txt configuration.
// Mounted under /api/admin, which already requires an admin session.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { idParamSchema } from "./admin.schema";
import * as sitemap from "@/modules/seo/sitemap.service";

const router = Router();

const CHANGE_FREQ = ["ALWAYS", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY", "NEVER"] as const;

// Counts, plus why URLs were withheld — the screen explains its own numbers.
router.get(
  "/sitemap",
  asyncHandler(async (_req, res) => ok(res, await sitemap.getSitemapStats()))
);

router.patch(
  "/sitemap/settings",
  validate(
    z.object({
      body: z.object({
        siteUrl: z.string().url().optional(),
        allowIndexing: z.boolean().optional(),
        sitemapEnabled: z.boolean().optional(),
        robotsEnabled: z.boolean().optional(),
        // The spec caps a file at 50,000 URLs.
        maxUrlsPerFile: z.number().int().min(100).max(50000).optional(),
        robotsExtra: z.union([z.string(), z.null()]).optional(),
        crawlDelay: z.union([z.number().int().min(0).max(120), z.null()]).optional(),
        imagesEnabled: z.boolean().optional(),
        imageUrlMode: z.enum(["optimizer", "direct"]).optional(),
        imageOptimizerWidth: z.number().int().min(320).max(3840).optional(),
        listCitySitemapsInRobots: z.boolean().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => ok(res, await sitemap.updateSettings(req.body)))
);

router.patch(
  "/sitemap/sections/:id",
  validate(idParamSchema),
  validate(
    z.object({
      body: z.object({
        isEnabled: z.boolean().optional(),
        changeFreq: z.enum(CHANGE_FREQ).optional(),
        priority: z.number().min(0).max(1).optional(),
        minResidenceCount: z.number().int().min(0).optional(),
        includeLastmod: z.boolean().optional(),
        requireSitemapFlag: z.boolean().optional(),
        // "cities" section: the weights for the tag pages and listings that
        // share a city file with the city page itself.
        tagPriority: z.number().min(0).max(1).optional(),
        tagChangeFreq: z.enum(CHANGE_FREQ).optional(),
        listingPriority: z.number().min(0).max(1).optional(),
        listingChangeFreq: z.enum(CHANGE_FREQ).optional(),
        sortOrder: z.number().int().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(res, await sitemap.updateSection(Number(req.params.id), req.body))
  )
);

// Live preview of the generated files, so the settings can be checked without
// hitting the public URLs.
router.get(
  "/sitemap/preview/robots",
  asyncHandler(async (_req, res) => ok(res, { content: await sitemap.renderRobots() }))
);

router.get(
  "/sitemap/preview/index",
  asyncHandler(async (_req, res) => ok(res, { content: await sitemap.renderIndex() }))
);

router.get(
  "/sitemap/preview/section/:key",
  asyncHandler(async (req, res) => {
    const urls = await sitemap.getSectionPage(req.params.key as sitemap.SectionKey, 1);
    return ok(res, { total: urls.length, sample: urls.slice(0, 25) });
  })
);

const robotsRuleBody = z.object({
  body: z.object({
    userAgent: z.string().optional(),
    directive: z.enum(["Allow", "Disallow"]).optional(),
    path: z.string().min(1).optional(),
    note: z.union([z.string(), z.null()]).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

router.get(
  "/robots-rules",
  asyncHandler(async (_req, res) => ok(res, await sitemap.robotsRules.list()))
);

router.post(
  "/robots-rules",
  validate(robotsRuleBody),
  asyncHandler(async (req, res) => ok(res, await sitemap.robotsRules.create(req.body), 201))
);

router.patch(
  "/robots-rules/:id",
  validate(idParamSchema),
  validate(robotsRuleBody),
  asyncHandler(async (req, res) =>
    ok(res, await sitemap.robotsRules.update(Number(req.params.id), req.body))
  )
);

router.delete(
  "/robots-rules/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await sitemap.robotsRules.remove(Number(req.params.id))))
);

export default router;
