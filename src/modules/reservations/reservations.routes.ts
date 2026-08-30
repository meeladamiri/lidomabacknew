import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireHost } from "@/middleware/auth";
import {
  cancelReservationSchema,
  createReservationSchema,
  guestCancelReservationSchema,
  rejectReservationSchema,
  replyToReviewSchema,
  reservationIdParamSchema,
  reviewIdParamSchema,
  submitReviewSchema,
} from "./reservations.schema";
import * as controller from "./reservations.controller";

// Guest-facing, mounted at /api/reservations
const router = Router();
router.use(requireAuth);

router.post("/", validate(createReservationSchema), asyncHandler(controller.create));
router.get("/mine", asyncHandler(controller.mine));
router.get("/:id", validate(reservationIdParamSchema), asyncHandler(controller.detail));
// Shown before the guest confirms: the policy says the amount "در هنگام لغو
// رزرو برای کاربر به نمایش درمی‌آید", and it never was.
router.get(
  "/:id/cancel-quote",
  validate(reservationIdParamSchema),
  asyncHandler(controller.cancelQuote)
);

router.post(
  "/:id/cancel",
  validate(guestCancelReservationSchema),
  asyncHandler(controller.guestCancel)
);
router.get("/:id/review", validate(reservationIdParamSchema), asyncHandler(controller.getMyReview));
router.post("/:id/review", validate(submitReviewSchema), asyncHandler(controller.submitReview));

// Host-facing, mounted at /api/host/reservations
const hostRouter = Router();
hostRouter.use(requireAuth, requireHost);

hostRouter.get("/", asyncHandler(controller.hostList));
hostRouter.post("/:id/accept", validate(reservationIdParamSchema), asyncHandler(controller.accept));
hostRouter.post("/:id/reject", validate(rejectReservationSchema), asyncHandler(controller.reject));
hostRouter.post("/:id/cancel", validate(cancelReservationSchema), asyncHandler(controller.hostCancel));

hostRouter.get("/reviews", asyncHandler(controller.listHostReviews));
hostRouter.get(
  "/reviews/:reviewId",
  validate(reviewIdParamSchema),
  asyncHandler(controller.getHostReviewDetail)
);
hostRouter.post(
  "/reviews/:reviewId/reply",
  validate(replyToReviewSchema),
  asyncHandler(controller.replyToReview)
);

export { router as guestReservationRoutes, hostRouter as hostReservationRoutes };
