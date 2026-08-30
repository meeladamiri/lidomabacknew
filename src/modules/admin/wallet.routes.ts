import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok, paginated } from "@/utils/response";
import { prisma } from "@/lib/prisma";
import * as settlements from "@/modules/wallet/settlements.service";
import * as wallet from "@/modules/wallet/wallet.service";
import * as deposits from "@/modules/wallet/deposits.service";
import { runJobNow, schedulerStatus } from "@/lib/scheduler";

/**
 * Wallet administration.
 *
 * Mounted under the admin router, so the admin session is already required and
 * the cache-invalidation middleware already runs on writes.
 *
 * Note what is absent: nothing here edits a balance directly. Money moves only
 * by writing a ledger row, so every change has a reason, an author and a
 * timestamp. `adjust` is the escape hatch for corrections and it is a
 * transaction like any other.
 */
const router = Router();

const listQuery = z.object({
  query: z.object({
    status: z.enum(["REQUESTED", "APPROVED", "PAID", "REJECTED"]).optional(),
    cursor: z.coerce.number().int().positive().optional(),
    take: z.coerce.number().int().min(1).max(50).optional(),
  }),
});


const noteBody = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ note: z.string().max(500).optional() }),
});

const rejectBody = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    // Required, not optional: a rejection the host cannot understand becomes a
    // support ticket, and the reason is shown to them.
    reason: z.string().min(3).max(500),
  }),
});

const adjustBody = z.object({
  params: z.object({ userId: z.coerce.number().int().positive() }),
  body: z.object({
    amount: z.number().refine((n) => n !== 0, "مبلغ نمی‌تواند صفر باشد"),
    description: z.string().min(3).max(300),
    blocked: z.boolean().optional(),
  }),
});

router.get(
  "/settlements",
  validate(listQuery),
  asyncHandler(async (req, res) => {
    const { status, cursor, take } = req.query as unknown as {
      status?: "REQUESTED" | "APPROVED" | "PAID" | "REJECTED";
      cursor?: number;
      take?: number;
    };
    return ok(res, await settlements.listForAdmin({ status, cursor, take }));
  })
);

router.post(
  "/settlements/:id/approve",
  validate(noteBody),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { note } = req.body as { note?: string };
    return ok(res, await settlements.approve(id, req.user!.sub, note));
  })
);

router.post(
  "/settlements/:id/paid",
  validate(noteBody),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { note } = req.body as { note?: string };
    return ok(res, await settlements.markPaid(id, req.user!.sub, note));
  })
);

router.post(
  "/settlements/:id/reject",
  validate(rejectBody),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { reason } = req.body as { reason: string };
    return ok(res, await settlements.reject(id, req.user!.sub, reason));
  })
);

/** One user's wallet, for the user detail page. */
router.get(
  "/users/:userId",
  validate(z.object({ params: z.object({ userId: z.coerce.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { userId } = req.params as unknown as { userId: number };
    const [summary, transactions] = await Promise.all([
      wallet.summary(userId),
      wallet.listTransactions(userId, { take: 50 }),
    ]);
    return ok(res, { ...summary, transactions: transactions.items });
  })
);

/** A manual correction. Always a ledger row, never an edit to a balance. */
router.post(
  "/users/:userId/adjust",
  validate(adjustBody),
  asyncHandler(async (req, res) => {
    const { userId } = req.params as unknown as { userId: number };
    const { amount, description, blocked } = req.body as {
      amount: number;
      description: string;
      blocked?: boolean;
    };

    const result = await wallet.credit({
      userId,
      kind: "ADJUSTMENT",
      amount,
      // Who did it, in the row itself — the ledger is the audit trail.
      description: `${description} (توسط ادمین #${req.user!.sub})`,
      blocked,
    });

    // The admin list shows the user's name; keep it fresh for the response.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });

    return ok(res, { user, balance: result.wallet.balance, transaction: result.transaction.id });
  })
);

/**
 * Runs the maturity sweep by hand.
 *
 * The scheduler runs it hourly on its own; this stays for the times somebody
 * needs it to have happened *now* — a host on the phone asking where their
 * money is — and it goes through the scheduler so the panel's "last run" is
 * the truth rather than a figure that ignores manual runs.
 */
router.post(
  "/release-matured",
  asyncHandler(async (_req, res) => ok(res, await runJobNow("release-matured")))
);

/** What the scheduler is doing, for the panel. */
router.get(
  "/scheduler",
  asyncHandler(async (_req, res) => ok(res, schedulerStatus()))
);

// ---------- Deposits (Odoo's x_clearing) ----------

/**
 * The deposit queue: bookings the site owes a host money on, with what has
 * already been sent. Odoo showed the same figure as «مانده واریز».
 */
router.get(
  "/deposits/payables",
  validate(
    z.object({
      query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
        hostId: z.coerce.number().int().positive().optional(),
        filter: z.enum(["unpaid", "partial", "settled", "all"]).optional(),
        q: z.string().max(120).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const result = await deposits.listPayables({
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      hostId: req.query.hostId ? Number(req.query.hostId) : undefined,
      filter: req.query.filter as deposits.PayableFilter | undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });

    return paginated(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  })
);

/** What has actually been sent, newest first. */
router.get(
  "/deposits",
  validate(
    z.object({
      query: z.object({
        hostId: z.coerce.number().int().positive().optional(),
        reservationId: z.coerce.number().int().positive().optional(),
        take: z.coerce.number().int().min(1).max(200).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await deposits.listDeposits({
        hostId: req.query.hostId ? Number(req.query.hostId) : undefined,
        reservationId: req.query.reservationId ? Number(req.query.reservationId) : undefined,
        take: req.query.take ? Number(req.query.take) : undefined,
      })
    )
  )
);

/** Records a payment to a host and debits the wallet, in one transaction. */
router.post(
  "/deposits",
  validate(
    z.object({
      body: z.object({
        hostId: z.number().int().positive(),
        reservationId: z.number().int().positive().nullable().optional(),
        amount: z.number().positive(),
        txnId: z.string().max(120).nullable().optional(),
        sender: z.string().max(120).nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        depositedAt: z.coerce.date().nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await deposits.createDeposit({
        ...req.body,
        adminId: req.user!.sub,
      })
    )
  )
);

export default router;
