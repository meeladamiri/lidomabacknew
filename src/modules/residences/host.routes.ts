import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import { requireUploadStorage, upload } from "@/middleware/upload";
import {
  changeStateSchema,
  createResidenceSchema,
  createRoomSchema,
  replaceRoomsSchema,
  reorderImagesSchema,
  residenceIdParamSchema,
  updateAmenitiesSchema,
  updateCapacitySchema,
  updateInstantBookingSchema,
  updatePricingSchema,
  updateRoomSchema,
  updateRulesSchema,
  updateSpecsSchema,
  updateImageSchema,
} from "./residences.schema";
import * as controller from "./host.controller";
import { classificationBodySchema } from "./residences.schema";

const router = Router();

/**
 * Not `requireHost`.
 *
 * This router is also the submission wizard a guest uses to become a host —
 * `classification-options` and `POST /` (the draft this is all keyed by) are
 * its very first screen, reached before the user's access token has ever had
 * `isHost: true` in it. Gating the whole router on that flag meant nobody
 * could ever pass through it for the first time: `POST /api/users/me` can
 * flip the DB column, but nothing re-mints the token that already sits in
 * the browser, so the very next call here would still 403.
 *
 * Every handler below scopes by `hostId: req.user.sub` on its own
 * (`getHostResidenceFull`, `createResidence`, …) — that ownership check is
 * the actual authorization, and it does not depend on the flag. `isHost` is
 * flipped in `createResidence` itself, the moment a user's first residence
 * exists, rather than gating the door to creating it.
 */
router.use(requireAuth);

router.get("/", asyncHandler(controller.list));
router.post("/", validate(createResidenceSchema), asyncHandler(controller.create));
router.get("/stats", asyncHandler(controller.stats));

// The two taxonomies the SEO tag pages are built from. Fixed path, declared
// before "/:id" could swallow it.
router.get("/classification-options", asyncHandler(controller.classificationOptions));

// The wizard's own copy: titles, descriptions and the option tiles. Fixed
// path, so it is declared before "/:id" could swallow it.
router.get("/wizard-content", asyncHandler(controller.wizardContent));
router.get("/:id", validate(residenceIdParamSchema), asyncHandler(controller.getOne));
router.patch("/:id", validate(updateSpecsSchema), asyncHandler(controller.updateSpecs));
router.patch("/:id/amenities", validate(updateAmenitiesSchema), asyncHandler(controller.updateAmenities));
router.patch("/:id/rules", validate(updateRulesSchema), asyncHandler(controller.updateRules));
router.patch("/:id/pricing", validate(updatePricingSchema), asyncHandler(controller.updatePricing));
router.patch("/:id/capacity", validate(updateCapacitySchema), asyncHandler(controller.updateCapacity));
router.patch(
  "/:id/instant-booking",
  validate(updateInstantBookingSchema),
  asyncHandler(controller.updateInstantBooking)
);
router.patch("/:id/state", validate(changeStateSchema), asyncHandler(controller.changeState));
router.get("/:id/classification", validate(residenceIdParamSchema), asyncHandler(controller.residenceClassification));
router.patch(
  "/:id/classification",
  validate(classificationBodySchema),
  asyncHandler(controller.saveClassification)
);

router.post("/:id/rooms", validate(createRoomSchema), asyncHandler(controller.addRoom));
router.put("/:id/rooms", validate(replaceRoomsSchema), asyncHandler(controller.replaceRooms));
router.patch("/rooms/:roomId", validate(updateRoomSchema), asyncHandler(controller.updateRoom));
router.delete("/rooms/:roomId", asyncHandler(controller.deleteRoom));

router.post(
  "/:id/images",
  validate(residenceIdParamSchema),
  requireUploadStorage,
  upload.single("image"),
  asyncHandler(controller.uploadImage)
);
router.patch("/:id/images/:imageId", validate(updateImageSchema), asyncHandler(controller.updateImage));
router.delete("/:id/images/:imageId", asyncHandler(controller.deleteImage));
router.post("/:id/images/order", validate(reorderImagesSchema), asyncHandler(controller.reorderImages));

router.post(
  "/:id/documents",
  validate(residenceIdParamSchema),
  requireUploadStorage,
  upload.fields([
    { name: "hostNationalCard", maxCount: 1 },
    { name: "document", maxCount: 1 },
    { name: "ownerNationalCard", maxCount: 1 },
  ]),
  asyncHandler(controller.updateDocuments)
);

/** «درخواست بررسی مجدد» — bulk-marks every open defect ready for another look. */
router.post(
  "/:id/defects/request-review",
  validate(residenceIdParamSchema),
  asyncHandler(controller.requestDefectReview)
);

export default router;
