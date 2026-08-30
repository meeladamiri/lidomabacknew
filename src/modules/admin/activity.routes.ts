import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import * as activity from "@/modules/activity/activity.service";

/**
 * The activity log's API.
 *
 * Three verbs and no more: list it, add a call, add a note. There is no update
 * and no delete, and the database would refuse them anyway — this router not
 * offering them is the second lock, not the only one.
 */
const router = Router();

const KINDS = ["CALL", "NOTE", "STATE_CHANGE", "FIELD_CHANGE", "MESSAGE_SENT"] as const;

router.get(
  "/",
  validate(
    z.object({
      query: z.object({
        reservationId: z.coerce.number().int().positive().optional(),
        userId: z.coerce.number().int().positive().optional(),
        kind: z.enum(KINDS).optional(),
        actorId: z.coerce.number().int().positive().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        cursor: z.coerce.number().int().positive().optional(),
        take: z.coerce.number().int().min(1).max(100).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(res, await activity.list(req.query as unknown as activity.ListFilters))
  )
);

/** Who has written to the log, for the filter dropdown. */
router.get("/actors", asyncHandler(async (_req, res) => ok(res, await activity.actors())));

router.post(
  "/calls",
  validate(
    z.object({
      body: z.object({
        direction: z.enum(["INBOUND", "OUTBOUND"]),
        party: z.enum(["GUEST", "HOST", "OTHER"]),
        summary: z.string().min(3).max(2000),
        outcome: z.string().max(120).nullable().optional(),
        reservationId: z.number().int().positive().nullable().optional(),
        userId: z.number().int().positive().nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(res, await activity.logCall({ ...req.body, actorId: req.user!.sub }), 201)
  )
);

router.post(
  "/notes",
  validate(
    z.object({
      body: z.object({
        summary: z.string().min(3).max(2000),
        reservationId: z.number().int().positive().nullable().optional(),
        userId: z.number().int().positive().nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { summary, reservationId, userId } = req.body as {
      summary: string;
      reservationId?: number | null;
      userId?: number | null;
    };

    return ok(
      res,
      await activity.record({
        kind: "NOTE",
        summary,
        reservationId,
        userId,
        actorId: req.user!.sub,
        source: "MANUAL",
      }),
      201
    );
  })
);

export default router;
