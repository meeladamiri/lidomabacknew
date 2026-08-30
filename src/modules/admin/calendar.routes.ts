import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import * as calendar from "./calendar.service";

/** تقویم و نرخ, from the panel. Mounted under the admin router. */
const router = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get(
  "/residences/:id/calendar",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({
        from: z.string().regex(DATE),
        to: z.string().regex(DATE),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { from, to } = req.query as unknown as { from: string; to: string };
    return ok(res, await calendar.getAdminCalendar(id, from, to));
  })
);

router.patch(
  "/residences/:id/calendar",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({
        dates: z.array(z.string().regex(DATE)).min(1).max(370),
        isBlocked: z.boolean().optional(),
        isPeak: z.boolean().optional(),
        isFast: z.boolean().optional(),
        // Null clears the override and puts the night back on the base ladder,
        // which is different from setting it to zero.
        specialPrice: z.number().min(0).nullable().optional(),
        reset: z.boolean().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(
      res,
      await calendar.updateAdminCalendar({
        residenceId: id,
        ...(req.body as Omit<calendar.AdminCalendarUpdate, "residenceId" | "actorId">),
        actorId: req.user!.sub,
      })
    );
  })
);

/** The before/after preview. Read-only, and the only way to reach the apply. */
router.get(
  "/reservations/:id/reprice",
  validate(z.object({ params: z.object({ id: z.coerce.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await calendar.repriceQuote(id));
  })
);

router.post(
  "/reservations/:id/reprice",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({ note: z.string().min(3).max(500) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { note } = req.body as { note: string };
    return ok(res, await calendar.applyReprice({ reservationId: id, note, actorId: req.user!.sub }));
  })
);

export default router;
