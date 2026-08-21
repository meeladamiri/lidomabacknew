import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import {
  idParamSchema,
  listQuerySchema,
  filterPresetSchema,
  residenceStateSchema,
  updateReservationSchema,
  updateUserSchema,
  upsertAmenitySchema,
  upsertCitySchema,
  upsertProvinceSchema,
  upsertRuleSchema,
} from "./admin.schema";
import {
  createRoomSchema,
  replaceRoomsSchema,
  reorderImagesSchema,
  residenceIdParamSchema,
  updateAmenitiesSchema,
  updateCapacitySchema,
  updatePricingSchema,
  updateRoomSchema,
  updateRulesSchema,
  updateSpecsSchema,
} from "@/modules/residences/residences.schema";
import * as controller from "./admin.controller";
import * as service from "./admin.service";
import { buildCatalogRouter } from "./catalogRouter";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/dashboard/stats", asyncHandler(controller.dashboardStats));

router.get("/users", validate(listQuerySchema), asyncHandler(controller.listUsers));
router.get("/users/:id", validate(idParamSchema), asyncHandler(controller.getUser));
router.patch("/users/:id", validate(updateUserSchema), asyncHandler(controller.updateUser));

router.get("/residences/filter-fields", asyncHandler(controller.residenceFilterFields));
router.get("/residences", validate(listQuerySchema), asyncHandler(controller.listResidences));
router.get("/residences/:id", validate(idParamSchema), asyncHandler(controller.getResidence));
router.patch(
  "/residences/:id/state",
  validate(residenceStateSchema),
  asyncHandler(controller.setResidenceState)
);
router.patch("/residences/:id", validate(updateSpecsSchema), asyncHandler(controller.updateResidenceSpecs));
router.patch(
  "/residences/:id/amenities",
  validate(updateAmenitiesSchema),
  asyncHandler(controller.updateResidenceAmenities)
);
router.patch("/residences/:id/rules", validate(updateRulesSchema), asyncHandler(controller.updateResidenceRules));
router.patch(
  "/residences/:id/pricing",
  validate(updatePricingSchema),
  asyncHandler(controller.updateResidencePricing)
);
router.patch(
  "/residences/:id/capacity",
  validate(updateCapacitySchema),
  asyncHandler(controller.updateResidenceCapacity)
);

router.post("/residences/:id/rooms", validate(createRoomSchema), asyncHandler(controller.addResidenceRoom));
router.put("/residences/:id/rooms", validate(replaceRoomsSchema), asyncHandler(controller.replaceResidenceRooms));
router.patch("/rooms/:roomId", validate(updateRoomSchema), asyncHandler(controller.updateResidenceRoom));
router.delete("/rooms/:roomId", asyncHandler(controller.deleteResidenceRoom));

router.post(
  "/residences/:id/images",
  validate(residenceIdParamSchema),
  upload.single("image"),
  asyncHandler(controller.uploadResidenceImage)
);
router.delete("/residences/:id/images/:imageId", asyncHandler(controller.deleteResidenceImage));
router.post(
  "/residences/:id/images/order",
  validate(reorderImagesSchema),
  asyncHandler(controller.reorderResidenceImages)
);

router.get("/reservations", validate(listQuerySchema), asyncHandler(controller.listReservations));
router.get("/reservations/:id", validate(idParamSchema), asyncHandler(controller.getReservation));
router.patch(
  "/reservations/:id",
  validate(updateReservationSchema),
  asyncHandler(controller.updateReservation)
);

router.get("/filter-presets", asyncHandler(controller.listFilterPresets));
router.post("/filter-presets", validate(filterPresetSchema), asyncHandler(controller.createFilterPreset));
router.delete("/filter-presets/:id", validate(idParamSchema), asyncHandler(controller.deleteFilterPreset));

router.use("/amenities", buildCatalogRouter(service.amenities, upsertAmenitySchema));
router.use("/rules", buildCatalogRouter(service.rules, upsertRuleSchema));
router.use("/cities", buildCatalogRouter(service.cities, upsertCitySchema));
router.use("/provinces", buildCatalogRouter(service.provinces, upsertProvinceSchema));

export default router;
