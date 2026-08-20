import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireHost } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import {
  changeStateSchema,
  createResidenceSchema,
  createRoomSchema,
  reorderImagesSchema,
  residenceIdParamSchema,
  updateAmenitiesSchema,
  updateCapacitySchema,
  updatePricingSchema,
  updateRoomSchema,
  updateRulesSchema,
  updateSpecsSchema,
} from "./residences.schema";
import * as controller from "./host.controller";

const router = Router();

router.use(requireAuth, requireHost);

router.get("/", asyncHandler(controller.list));
router.post("/", validate(createResidenceSchema), asyncHandler(controller.create));
router.get("/:id", validate(residenceIdParamSchema), asyncHandler(controller.getOne));
router.patch("/:id", validate(updateSpecsSchema), asyncHandler(controller.updateSpecs));
router.patch("/:id/amenities", validate(updateAmenitiesSchema), asyncHandler(controller.updateAmenities));
router.patch("/:id/rules", validate(updateRulesSchema), asyncHandler(controller.updateRules));
router.patch("/:id/pricing", validate(updatePricingSchema), asyncHandler(controller.updatePricing));
router.patch("/:id/capacity", validate(updateCapacitySchema), asyncHandler(controller.updateCapacity));
router.patch("/:id/state", validate(changeStateSchema), asyncHandler(controller.changeState));

router.post("/:id/rooms", validate(createRoomSchema), asyncHandler(controller.addRoom));
router.patch("/rooms/:roomId", validate(updateRoomSchema), asyncHandler(controller.updateRoom));
router.delete("/rooms/:roomId", asyncHandler(controller.deleteRoom));

router.post("/:id/images", validate(residenceIdParamSchema), upload.single("image"), asyncHandler(controller.uploadImage));
router.delete("/:id/images/:imageId", asyncHandler(controller.deleteImage));
router.post("/:id/images/order", validate(reorderImagesSchema), asyncHandler(controller.reorderImages));

export default router;
