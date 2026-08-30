import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import * as settings from "@/modules/settings/reservationSettings.service";

/**
 * تنظیمات رزرواسیون — the rates every booking is split by.
 *
 * Read-mostly and tiny, but it is the one place a rate can be changed, so the
 * response also reports how many hosts carry their own rate: raising the site
 * rate does nothing for those, and that is worth seeing before saving rather
 * than discovering from a host's invoice later.
 */
const router = Router();

router.get(
  "/reservation",
  asyncHandler(async (_req, res) => {
    const [current, overrides] = await Promise.all([
      settings.getSettings(),
      settings.countHostOverrides(),
    ]);
    return ok(res, { ...current, hostOverrides: overrides });
  })
);

router.put(
  "/reservation",
  validate(
    z.object({
      body: z.object({
        commissionPercent: z.number().min(0).max(100).optional(),
        vatPercent: z.number().min(0).max(100).optional(),
        guestCommissionPercent: z.number().min(0).max(100).optional(),
        releaseOnStartDate: z.boolean().optional(),
        minSettlement: z.number().int().min(0).max(100_000_000).optional(),
        // A window of zero would expire every booking the moment it is made,
        // so the floor is one minute. The ceiling is a week.
        approvalWindowMinutes: z.number().int().min(1).max(10_080).optional(),
        paymentWindowMinutes: z.number().int().min(1).max(10_080).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => ok(res, await settings.updateSettings(req.body)))
);

export default router;
