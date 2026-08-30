import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { ok } from "@/utils/response";
import { prisma } from "@/lib/prisma";
import * as deposit from "./deposit.service";

/**
 * The finance team's deposit panel.
 *
 * Mounted outside `/admin` because the page it serves is at the site root and
 * is used by staff who never open the admin panel — that was true in Odoo too.
 * It still requires an admin session; `/permission` exists so the page can say
 * "you do not have access" instead of showing an empty table to everyone else.
 */
const router = Router();

/**
 * Answered for any signed-in user, which is why it is registered before the
 * admin guard: the page asks this first, and a 403 here would be indis­
 * tinguishable from the endpoint being broken.
 */
router.get(
  "/permission",
  requireAuth,
  asyncHandler(async (req, res) => ok(res, { has_permission: req.user?.role === "ADMIN" }))
);

router.use(requireAuth, requireAdmin);

/** Who is recording this, for the row's own audit line. */
async function actor(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, phone: true },
  });
  return { adminId: userId, adminName: user?.name || user?.phone || `ادمین #${userId}` };
}

router.get(
  "/checkouts",
  validate(
    z.object({
      query: z.object({
        startDate: z.coerce.date(),
        tillDate: z.coerce.date(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { startDate, tillDate } = req.query as unknown as { startDate: Date; tillDate: Date };
    return ok(res, { orders: await deposit.getCheckouts({ startDate, tillDate }) });
  })
);

router.post(
  "/settle",
  validate(
    z.object({
      body: z.object({
        reservationId: z.number().int().positive(),
        amount: z.number().positive(),
        type: z.enum(["remainder", "deposit", "host_debit"]),
        desc: z.string().max(500).nullable().optional(),
        reference: z.string().max(120).nullable().optional(),
        payWith: z.enum(["shaba", "card"]).nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(res, await deposit.saveSettleInfo({ ...req.body, ...(await actor(req.user!.sub)) }))
  )
);

router.post(
  "/batch-settle",
  validate(
    z.object({
      body: z.object({
        reservationIds: z.array(z.number().int().positive()).min(1),
        amount: z.number().positive(),
        desc: z.string().max(500).nullable().optional(),
        reference: z.string().max(120).nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) =>
    ok(res, await deposit.saveBatchSettle({ ...req.body, ...(await actor(req.user!.sub)) }))
  )
);

router.patch(
  "/:id/remainder",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({
        amount: z.number().min(0),
        desc: z.string().min(1).max(500),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { amount, desc } = req.body as { amount: number; desc: string };
    return ok(
      res,
      await deposit.updateRemainder({
        reservationId: id,
        amount,
        desc,
        ...(await actor(req.user!.sub)),
      })
    );
  })
);

router.patch(
  "/:id/description",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({ desc: z.string().max(2000) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { desc } = req.body as { desc: string };
    return ok(res, await deposit.saveSaleDescription(id, desc));
  })
);

router.put(
  "/hosts/:hostId/bank",
  validate(
    z.object({
      params: z.object({ hostId: z.coerce.number().int().positive() }),
      body: z.object({
        card: z.string().max(40).nullable().optional(),
        cardOwner: z.string().max(120).nullable().optional(),
        shaba: z.string().max(40).nullable().optional(),
        shabaOwner: z.string().max(120).nullable().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { hostId } = req.params as unknown as { hostId: number };
    return ok(res, await deposit.saveHostBankInfo({ hostId, ...req.body }));
  })
);

export default router;
