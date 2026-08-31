import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { rankInCity } from "./residenceRank.service";
import { changeHost } from "./residenceHost.service";
import {
  getClassification,
  setClassification,
  CLASSIFICATION_KEYS,
} from "./residenceClassification.service";

/** Listing-level actions the detail page needs. Mounted under the admin router. */
const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Where this listing sits in its city's search results, and where it would sit
 * at a different «اهمیت». Read-only, so the panel can show the effect of a
 * number before it is saved.
 */
router.get(
  "/residences/:id/rank",
  validate(
    z.object({
      params: idParam,
      query: z.object({ importance: z.coerce.number().int().min(0).optional() }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { importance } = req.query as unknown as { importance?: number };
    return ok(res, await rankInCity(id, importance));
  })
);

router.patch(
  "/residences/:id/host",
  validate(
    z.object({
      params: idParam,
      body: z.object({
        hostId: z.number().int().positive(),
        note: z.string().max(500).optional(),
        dryRun: z.boolean().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { hostId: number; note?: string; dryRun?: boolean };
    return ok(
      res,
      await changeHost({
        residenceId: id,
        newHostId: body.hostId,
        note: body.note ?? "",
        dryRun: body.dryRun,
        actorId: req.user!.sub,
      })
    );
  })
);

/**
 * «نوع اقامتگاه» و «منطقه اقامتگاه» — the two taxonomies the SEO tag pages
 * are built from. Read gives the options actually in use plus what this
 * listing answers; write touches only the one amenity.
 */
router.get(
  "/residences/:id/classification",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await getClassification(id));
  })
);

router.patch(
  "/residences/:id/classification",
  validate(
    z.object({
      params: idParam,
      body: z.object({
        key: z.enum(CLASSIFICATION_KEYS),
        values: z.array(z.string().max(80)).max(10),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { key: (typeof CLASSIFICATION_KEYS)[number]; values: string[] };
    return ok(
      res,
      await setClassification({ residenceId: id, ...body, actorId: req.user!.sub })
    );
  })
);

export default router;
