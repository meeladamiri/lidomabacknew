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

/** Draft rates: one price per night, keyed by date. */
const DRAFT = z.record(z.string().regex(DATE), z.number().min(0)).optional();

/** The before/after preview. Read-only, and the only way to reach the apply. */
router.get(
  "/reservations/:id/reprice",
  validate(z.object({ params: z.object({ id: z.coerce.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await calendar.repriceQuote(id));
  })
);

/**
 * The same preview, priced with rates the panel has typed but not saved.
 *
 * A POST because the draft can cover a year of nights and does not belong in
 * a query string; it still writes nothing.
 */
router.post(
  "/reservations/:id/reprice/preview",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({ draft: DRAFT }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { draft } = req.body as { draft?: calendar.DraftRates };
    return ok(res, await calendar.repriceQuote(id, draft));
  })
);

router.post(
  "/reservations/:id/reprice",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({ note: z.string().min(3).max(500), draft: DRAFT }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { note, draft } = req.body as { note: string; draft?: calendar.DraftRates };
    return ok(
      res,
      await calendar.applyReprice({ reservationId: id, note, draft, actorId: req.user!.sub })
    );
  })
);

export default router;
