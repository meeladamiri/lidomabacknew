import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import * as controller from "./notifications.controller";
import {
  archiveSchema,
  listNotificationsSchema,
  markReadSchema,
} from "./notifications.schema";

const router = Router();

// Every route here is about the caller's own notifications; there is no
// unauthenticated view of this list.
router.use(requireAuth);

// Fixed path first, so it is not read as an :id.
router.get("/unread-count", asyncHandler(controller.unreadCount));

router.get("/", validate(listNotificationsSchema), asyncHandler(controller.list));
router.post("/read", validate(markReadSchema), asyncHandler(controller.markRead));
router.post("/archive-all", asyncHandler(controller.archiveAll));
router.post("/:id/archive", validate(archiveSchema), asyncHandler(controller.archive));

export default router;
