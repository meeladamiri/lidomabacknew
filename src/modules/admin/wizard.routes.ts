/**
 * Panel editing for the submission wizard's content.
 *
 * Mounted under the admin router, so the cache-invalidation middleware already
 * covers these writes; the service drops its own key too, which is what makes
 * an edit show up on the next wizard load rather than in an hour.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok, created } from "@/utils/response";
import * as service from "@/modules/residences/wizard.service";

const router = Router();

const stepSchema = z.object({
  params: z.object({ step: z.coerce.number().int().min(0).max(14) }),
  body: z.object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(1000).nullable().optional(),
    helpText: z.string().max(4000).nullable().optional(),
    iconUrl: z.string().max(1000).nullable().optional(),
    isEnabled: z.boolean().optional(),
  }),
});

const createOptionSchema = z.object({
  body: z.object({
    kind: z.enum(["RES_TYPE", "REGION", "RENT_TYPE"]),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).nullable().optional(),
    imageUrl: z.string().max(1000).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  }),
});

const updateOptionSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    imageUrl: z.string().max(1000).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

router.get(
  "/",
  asyncHandler(async (_req, res) => ok(res, await service.adminListWizardContent()))
);

router.patch(
  "/steps/:step",
  validate(stepSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.adminSaveStep(Number(req.params.step), req.body))
  )
);

router.post(
  "/options",
  validate(createOptionSchema),
  asyncHandler(async (req, res) => created(res, await service.adminCreateOption(req.body)))
);

router.patch(
  "/options/:id",
  validate(updateOptionSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.adminUpdateOption(Number(req.params.id), req.body))
  )
);

// Toggles rather than deletes — see the service for why.
router.post(
  "/options/:id/toggle",
  validate(idParamSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.adminDeactivateOption(Number(req.params.id)))
  )
);

export default router;
