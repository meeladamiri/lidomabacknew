import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import { AppError } from "@/lib/errors";
import { ok } from "@/utils/response";
import { prisma } from "@/lib/prisma";
import { upload, fileToUrl, deleteStoredFile } from "@/middleware/upload";

const router = Router();
router.use(requireAuth);

const ME_SELECT = {
  id: true,
  phone: true,
  name: true,
  email: true,
  nationalCode: true,
  address: true,
  cityId: true,
  zip: true,
  fax: true,
  job: true,
  education: true,
  birthDay: true,
  birthMonth: true,
  birthYear: true,
  emergencyPhone: true,
  contactPhone: true,
  avatarUrl: true,
  nationalCardUrl: true,
  description: true,
  verificationStatus: true,
  isHost: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  bankAccount: true,
  city: { include: { province: true } },
} as const;

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.sub },
      select: ME_SELECT,
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
    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: req.body,
      select: ME_SELECT,
    });
    return ok(res, user);
  })
);

router.post(
  "/me/avatar",
  upload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest("فایل تصویر ارسال نشده است");
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.sub },
      select: { avatarUrl: true },
    });
    const url = fileToUrl(req.file);
    const user = await prisma.user.update({
      where: { id: req.user!.sub },
      data: { avatarUrl: url },
      select: ME_SELECT,
    });
    await deleteStoredFile(current.avatarUrl);
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
