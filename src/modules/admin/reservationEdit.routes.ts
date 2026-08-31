import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import * as edit from "./reservationEdit.service";
import * as payments from "@/modules/reservations/payments.service";

/**
 * Editing a booking by hand: its terms, its stay, and what has been paid on it.
 *
 * Every route that changes money has a `dryRun` twin rather than a separate
 * preview endpoint, so the numbers an agent confirms come from the same code
 * path that will write them.
 */
const router = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const idParam = z.object({ id: z.coerce.number().int().positive() });

/* ── مبالغ مؤثر بر صورتحساب ─────────────────────────────────── */

const termsBody = z.object({
  websiteShare: z.number().min(0).optional(),
  vatAmount: z.number().min(0).optional(),
  guestCommission: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
  dryRun: z.boolean().optional(),
});

router.patch(
  "/reservations/:id/terms",
  validate(z.object({ params: idParam, body: termsBody })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as z.infer<typeof termsBody>;
    return ok(
      res,
      await edit.updateTerms({
        reservationId: id,
        ...body,
        note: body.note ?? "",
        actorId: req.user!.sub,
      })
    );
  })
);

/* ── تاریخ، شب و نفرات ──────────────────────────────────────── */

const stayBody = z.object({
  startDate: z.string().regex(DATE).optional(),
  endDate: z.string().regex(DATE).optional(),
  guestsCount: z.number().int().min(1).max(100).optional(),
  extraGuestsCount: z.number().int().min(0).max(100).optional(),
  note: z.string().max(500).optional(),
  dryRun: z.boolean().optional(),
});

router.patch(
  "/reservations/:id/stay",
  validate(z.object({ params: idParam, body: stayBody })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as z.infer<typeof stayBody>;
    return ok(
      res,
      await edit.updateStay({
        reservationId: id,
        ...body,
        note: body.note ?? "",
        actorId: req.user!.sub,
      })
    );
  })
);

/* ── پرداخت‌های مهمان ───────────────────────────────────────── */

router.get(
  "/reservations/:id/payments",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await payments.list(id));
  })
);

router.post(
  "/reservations/:id/payments",
  validate(
    z.object({
      params: idParam,
      body: z.object({
        amount: z.number().positive(),
        method: z.enum(["GATEWAY", "CARD_TRANSFER", "BANK_TRANSFER", "CASH", "WALLET", "OTHER"]),
        paidAt: z.coerce.date(),
        reference: z.string().max(120).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(
      res,
      await payments.record({
        reservationId: id,
        ...(req.body as Omit<Parameters<typeof payments.record>[0], "reservationId" | "actorId">),
        actorId: req.user!.sub,
      }),
      201
    );
  })
);

/**
 * Voiding rather than deleting. The row stays and stops counting, because
 * "we thought we had been paid on the 3rd" is what a dispute turns on.
 */
router.post(
  "/payments/:id/void",
  validate(
    z.object({
      params: idParam,
      body: z.object({ reason: z.string().min(3).max(300) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { reason } = req.body as { reason: string };
    return ok(res, await payments.voidPayment({ paymentId: id, reason, actorId: req.user!.sub }));
  })
);

export default router;
