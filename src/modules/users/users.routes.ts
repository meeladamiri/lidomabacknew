import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/lib/errors";
import { ok } from "@/utils/response";
import { prisma } from "@/lib/prisma";

const router = Router();
router.use(requireAuth);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.sub },
      include: { bankAccount: true, city: true },
    });
    return ok(res, user);
  })
);

const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    email: z.string().email().optional(),
    nationalCode: z.string().optional(),
    address: z.string().optional(),
    cityId: z.number().int().optional(),
    zip: z.string().optional(),
    fax: z.string().optional(),
    job: z.string().optional(),
    education: z.string().optional(),
    birthDay: z.number().int().optional(),
    birthMonth: z.number().int().optional(),
    birthYear: z.number().int().optional(),
    emergencyPhone: z.string().optional(),
    contactPhone: z.string().optional(),
    description: z.string().optional(),
    isHost: z.boolean().optional(), // user opting in to become a host
  }),
});

router.patch(
  "/me",
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.update({ where: { id: req.user!.sub }, data: req.body });
    return ok(res, user);
  })
);

const bankAccountSchema = z.object({
  body: z.object({
    cardNumber: z.string().optional(),
    cardOwnerName: z.string().optional(),
    shabaNumber: z.string().optional(),
    shabaOwnerName: z.string().optional(),
  }),
});

router.put(
  "/me/bank-account",
  validate(bankAccountSchema),
  asyncHandler(async (req, res) => {
    if (!req.user) throw AppError.unauthorized();
    const bankAccount = await prisma.bankAccount.upsert({
      where: { userId: req.user.sub },
      create: { userId: req.user.sub, ...req.body },
      update: req.body,
    });
    return ok(res, bankAccount);
  })
);

export default router;
