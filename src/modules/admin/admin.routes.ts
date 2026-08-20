import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireAdmin } from "@/middleware/auth";
import {
  idParamSchema,
  listQuerySchema,
  residenceStateSchema,
  updateUserSchema,
  upsertAmenitySchema,
  upsertCitySchema,
  upsertProvinceSchema,
  upsertRuleSchema,
} from "./admin.schema";
import * as controller from "./admin.controller";
import * as service from "./admin.service";
import { buildCatalogRouter } from "./catalogRouter";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/dashboard/stats", asyncHandler(controller.dashboardStats));

router.get("/users", validate(listQuerySchema), asyncHandler(controller.listUsers));
router.get("/users/:id", validate(idParamSchema), asyncHandler(controller.getUser));
router.patch("/users/:id", validate(updateUserSchema), asyncHandler(controller.updateUser));

router.get("/residences", validate(listQuerySchema), asyncHandler(controller.listResidences));
router.get("/residences/:id", validate(idParamSchema), asyncHandler(controller.getResidence));
router.patch(
  "/residences/:id/state",
  validate(residenceStateSchema),
  asyncHandler(controller.setResidenceState)
);

router.get("/reservations", validate(listQuerySchema), asyncHandler(controller.listReservations));
router.get("/reservations/:id", validate(idParamSchema), asyncHandler(controller.getReservation));

router.use("/amenities", buildCatalogRouter(service.amenities, upsertAmenitySchema));
router.use("/rules", buildCatalogRouter(service.rules, upsertRuleSchema));
router.use("/cities", buildCatalogRouter(service.cities, upsertCitySchema));
router.use("/provinces", buildCatalogRouter(service.provinces, upsertProvinceSchema));

export default router;
