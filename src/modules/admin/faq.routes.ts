// Admin routes for "سوالات متداول". Mounted under /api/admin.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { idParamSchema } from "./admin.schema";
import * as faq from "@/modules/seo/faq.service";

const router = Router();

const SCOPES = [
  "GLOBAL",
  "SEARCH",
  "LOCATION",
  "TAG",
  "TAG_LOCATION",
  "RESIDENCE",
  "PAGE",
] as const;

const faqBody = z.object({
  body: z.object({
    scope: z.enum(SCOPES).optional(),
    locationId: z.union([z.number().int(), z.null()]).optional(),
    tagId: z.union([z.number().int(), z.null()]).optional(),
    path: z.union([z.string(), z.null()]).optional(),
    question: z.string().min(1).optional(),
    answer: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

router.get(
  "/faqs",
  asyncHandler(async (req, res) =>
    ok(
      res,
      await faq.listFaqs({
        scope: req.query.scope as any,
        locationId: req.query.locationId ? Number(req.query.locationId) : undefined,
        tagId: req.query.tagId ? Number(req.query.tagId) : undefined,
        q: req.query.q as string | undefined,
      })
    )
  )
);

// "این صفحه چه سوال‌هایی نشون می‌ده؟" — the resolved list for a real page,
// which is what the admin actually needs to check, since the raw rows do not
// reveal what any given page ends up rendering.
router.get(
  "/faqs/preview",
  asyncHandler(async (req, res) =>
    ok(
      res,
      await faq.previewFaqsForPage({
        slug: req.query.slug as string | undefined,
        tagKey: req.query.tag as string | undefined,
        kind: req.query.kind as string | undefined,
        path: req.query.path as string | undefined,
      })
    )
  )
);

router.post(
  "/faqs",
  validate(faqBody),
  asyncHandler(async (req, res) => ok(res, await faq.createFaq(req.body), 201))
);

router.patch(
  "/faqs/:id",
  validate(idParamSchema),
  validate(faqBody),
  asyncHandler(async (req, res) => ok(res, await faq.updateFaq(Number(req.params.id), req.body)))
);

router.delete(
  "/faqs/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => ok(res, await faq.deleteFaq(Number(req.params.id))))
);

router.put(
  "/faqs/reorder",
  validate(z.object({ body: z.object({ ids: z.array(z.number().int()) }) })),
  asyncHandler(async (req, res) => ok(res, await faq.reorderFaqs(req.body.ids)))
);

export default router;
