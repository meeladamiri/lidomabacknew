import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { residenceIdParamSchema, hostIdParamSchema } from "./residences.schema";
import * as controller from "./residences.controller";

const router = Router();

router.get("/amenities", asyncHandler(controller.amenityCatalog));
router.get("/rules", asyncHandler(controller.ruleCatalog));
router.get("/hosts/:hostId", validate(hostIdParamSchema), asyncHandler(controller.hostProfile));
// Fixed path, declared before "/:id" so it can't be swallowed by it.
router.get(
  "/:id/redirect",
  validate(residenceIdParamSchema),
  asyncHandler(controller.getRedirect)
);
router.get("/:id", validate(residenceIdParamSchema), asyncHandler(controller.getDetail));

export default router;
