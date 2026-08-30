import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import { upload } from "@/middleware/upload";
import {
  idParamSchema,
  listQuerySchema,
  userListQuerySchema,
  residenceListQuerySchema,
  bulkIdsSchema,
  bulkStateSchema,
  bulkTypeSchema,
  distancesSchema,
  extraCitiesSchema,
  createUserSchema,
  setPasswordSchema,
  yellowCardSchema,
  filterPresetSchema,
  residenceStateSchema,
  updateReservationSchema,
  setReservationExpirySchema,
  updateUserSchema,
  upsertAmenitySchema,
  upsertCitySchema,
  upsertPeakDaySchema,
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
import taxonomyRouter from "./taxonomy.routes";
import sitemapRouter from "./sitemap.routes";
import faqRouter from "./faq.routes";
import homeAdminRouter from "./home.routes";
import conversationsAdminRouter from "./conversations.routes";
import wizardAdminRouter from "./wizard.routes";
import cacheAdminRouter from "./cache.routes";
import walletAdminRouter from "./wallet.routes";
import reservationSettingsRouter from "./reservationSettings.routes";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/dashboard/stats", asyncHandler(controller.dashboardStats));
router.get("/dashboard/overview", asyncHandler(controller.dashboardOverview));

router.get("/users/tab-counts", asyncHandler(controller.userTabCounts));
router.get("/users", validate(userListQuerySchema), asyncHandler(controller.listUsers));
router.post("/users", validate(createUserSchema), asyncHandler(controller.createUser));
router.get("/users/:id", validate(idParamSchema), asyncHandler(controller.getUser));
router.patch("/users/:id", validate(updateUserSchema), asyncHandler(controller.updateUser));
router.post("/users/:id/password", validate(setPasswordSchema), asyncHandler(controller.setUserPassword));
router.post("/users/:id/yellow-cards", validate(yellowCardSchema), asyncHandler(controller.addYellowCard));
router.delete("/yellow-cards/:id", validate(idParamSchema), asyncHandler(controller.removeYellowCard));

router.get("/residences/filter-fields", asyncHandler(controller.residenceFilterFields));
router.get("/residences/tab-counts", asyncHandler(controller.residenceTabCounts));
router.get("/residences", validate(residenceListQuerySchema), asyncHandler(controller.listResidences));
router.post("/residences/bulk/state", validate(bulkStateSchema), asyncHandler(controller.bulkResidenceState));
router.post("/residences/bulk/type", validate(bulkTypeSchema), asyncHandler(controller.bulkResidenceType));
router.post("/residences/bulk/delete", validate(bulkIdsSchema), asyncHandler(controller.bulkDeleteResidences));
router.post("/residences/bulk/copy", validate(bulkIdsSchema), asyncHandler(controller.bulkCopyResidences));
router.post("/residences/bulk/export", validate(bulkIdsSchema), asyncHandler(controller.exportResidences));
router.get("/residences/:id", validate(idParamSchema), asyncHandler(controller.getResidence));
router.patch(
  "/residences/:id/state",
  validate(residenceStateSchema),
  asyncHandler(controller.setResidenceState)
);
router.patch("/residences/:id", validate(updateSpecsSchema), asyncHandler(controller.updateResidenceSpecs));
router.put("/residences/:id/distances", validate(distancesSchema), asyncHandler(controller.setResidenceDistances));
router.put("/residences/:id/extra-cities", validate(extraCitiesSchema), asyncHandler(controller.setResidenceExtraCities));
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

router.patch(
  "/reservations/:id/expiry",
  validate(setReservationExpirySchema),
  asyncHandler(controller.setReservationExpiry)
);

router.get("/filter-presets", asyncHandler(controller.listFilterPresets));
router.post("/filter-presets", validate(filterPresetSchema), asyncHandler(controller.createFilterPreset));
router.delete("/filter-presets/:id", validate(idParamSchema), asyncHandler(controller.deleteFilterPreset));

// Location tree + SEO tags + curated tag pages.
router.use(taxonomyRouter);

// Sitemap + robots.txt configuration.
router.use(sitemapRouter);

// "سوالات متداول".
router.use(faqRouter);

// Home page CMS.
router.use(homeAdminRouter);

router.use("/conversations", conversationsAdminRouter);
router.use("/wizard", wizardAdminRouter);
router.use("/cache", cacheAdminRouter);
router.use("/wallet", walletAdminRouter);
router.use("/settings", reservationSettingsRouter);

router.use("/amenities", buildCatalogRouter(service.amenities, upsertAmenitySchema));
router.use("/rules", buildCatalogRouter(service.rules, upsertRuleSchema));
router.use("/peak-days", buildCatalogRouter(service.peakDays, upsertPeakDaySchema));
router.use("/cities", buildCatalogRouter(service.cities, upsertCitySchema));
router.use("/provinces", buildCatalogRouter(service.provinces, upsertProvinceSchema));

export default router;
