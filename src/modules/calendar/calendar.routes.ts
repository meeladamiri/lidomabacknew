import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth, requireHost } from "@/middleware/auth";
import { getCalendarSchema, updateCalendarSchema } from "./calendar.schema";
import * as controller from "./calendar.controller";

// Public read (guests/search checking availability) + host-only writes.
const publicRouter = Router();
publicRouter.get("/:id/calendar", validate(getCalendarSchema), asyncHandler(controller.getCalendar));

const hostRouter = Router();
hostRouter.use(requireAuth, requireHost);
hostRouter.get("/:id/calendar", validate(getCalendarSchema), asyncHandler(controller.getHostCalendar));
hostRouter.patch("/:id/calendar", validate(updateCalendarSchema), asyncHandler(controller.updateCalendar));

export { publicRouter as publicCalendarRoutes, hostRouter as hostCalendarRoutes };
