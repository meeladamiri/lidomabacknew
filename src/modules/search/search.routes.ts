import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import {
  citySearchSchema,
  legacyImageSchema,
  legacyRedirectSchema,
  residenceSearchSchema,
  searchPageDataSchema,
} from "./search.schema";
import * as controller from "./search.controller";

const router = Router();

router.get("/destinations/popular", asyncHandler(controller.popularDestinations));
router.get("/cities", validate(citySearchSchema), asyncHandler(controller.searchCities));
router.get("/provinces", asyncHandler(controller.provincesAndCities));
router.get("/legacy-redirect", validate(legacyRedirectSchema), asyncHandler(controller.legacyRedirect));
router.get("/page-data", validate(searchPageDataSchema), asyncHandler(controller.searchPageData));
router.get("/legacy-image", validate(legacyImageSchema), asyncHandler(controller.legacyImage));
router.post("/residences", validate(residenceSearchSchema), asyncHandler(controller.searchResidences));

export default router;
