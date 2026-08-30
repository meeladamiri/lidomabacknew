import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import { ok, created } from "@/utils/response";
import * as wallet from "./wallet.service";
import * as settlements from "./settlements.service";

const router = Router();
router.use(requireAuth);

const cursorQuery = z.object({
  query: z.object({
    cursor: z.coerce.number().int().positive().optional(),
    take: z.coerce.number().int().min(1).max(50).optional(),
  }),
});

// Iranian card numbers are 16 digits, IBANs 24 after the IR prefix. Validated
// here rather than only in the UI: this is the number money gets sent to.
const bankSchema = z.object({
  body: z.object({
    credit_card: z
      .string()
      .regex(/^\d{16}$/, "شماره کارت باید ۱۶ رقم باشد")
      .optional()
      .nullable(),
    credit_owner: z.string().max(120).optional().nullable(),
    shaba: z
      .string()
      .regex(/^\d{24}$/, "شماره شبا باید ۲۴ رقم باشد")
      .optional()
      .nullable(),
    shaba_owner: z.string().max(120).optional().nullable(),
  }),
});

const settlementSchema = z.object({
  body: z.object({
    amount: z.number().positive(),
  }),
});

/** Asking for money out is rare and worth rate limiting on its own. */
const settlementLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.sub ?? req.ip),
  message: { status: "error", message: "تعداد درخواست‌های تسویه زیاد است." },
});

router.get(
  "/",
  asyncHandler(async (req, res) => ok(res, await wallet.summary(req.user!.sub)))
);

router.get(
  "/transactions",
  validate(cursorQuery),
  asyncHandler(async (req, res) => {
    const { cursor, take } = req.query as unknown as { cursor?: number; take?: number };
    return ok(res, await wallet.listTransactions(req.user!.sub, { cursor, take }));
  })
);

router.put(
  "/bank-account",
  validate(bankSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as Record<string, string | null>;
    return ok(
      res,
      await wallet.saveBankAccount(req.user!.sub, {
        cardNumber: b.credit_card ?? null,
        cardOwnerName: b.credit_owner ?? null,
        shabaNumber: b.shaba ?? null,
        shabaOwnerName: b.shaba_owner ?? null,
      })
    );
  })
);

router.get(
  "/settlements",
  validate(cursorQuery),
  asyncHandler(async (req, res) => {
    const { cursor, take } = req.query as unknown as { cursor?: number; take?: number };
    return ok(res, await settlements.listForUser(req.user!.sub, { cursor, take }));
  })
);

router.post(
  "/settlements",
  settlementLimiter,
  validate(settlementSchema),
  asyncHandler(async (req, res) => {
    const { amount } = req.body as { amount: number };
    return created(res, await settlements.request(req.user!.sub, amount));
  })
);

export default router;
