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
  "/",
  asyncHandler(async (req, res) => {
    const favourites = await prisma.favourite.findMany({
      where: { userId: req.user!.sub },
      include: {
        residence: {
          select: {
            id: true,
            name: true,
            averageRating: true,
            reviewsCount: true,
            weekPrice: true,
            maxCapacity: true,
            city: { select: { name: true } },
            images: { take: 1, orderBy: { sortOrder: "asc" } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, favourites);
  })
);

const toggleSchema = z.object({
  body: z.object({ residenceId: z.number().int(), action: z.enum(["like", "unlike"]) }),
});

router.post(
  "/toggle",
  validate(toggleSchema),
  asyncHandler(async (req, res) => {
    const { residenceId, action } = req.body;
    if (!req.user) throw AppError.unauthorized();

    if (action === "like") {
      await prisma.favourite.upsert({
        where: { userId_residenceId: { userId: req.user.sub, residenceId } },
        create: { userId: req.user.sub, residenceId },
        update: {},
      });
    } else {
      await prisma.favourite.deleteMany({ where: { userId: req.user.sub, residenceId } });
    }
    return ok(res, { success: true });
  })
);

export default router;
