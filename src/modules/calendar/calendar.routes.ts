import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import { getCalendarSchema, updateCalendarSchema } from "./calendar.schema";
import * as controller from "./calendar.controller";

// Public read (guests/search checking availability) + host-only writes.
const publicRouter = Router();
publicRouter.get("/:id/calendar", validate(getCalendarSchema), asyncHandler(controller.getCalendar));

const hostRouter = Router();
// Not `requireHost` — see the comment on host.routes.ts's router.use for why;
// this is a wizard step (pricing/calendar) on the same just-created draft and
// hits the same stale-token gap. `updateCalendar`/`getHostCalendar` both scope
// by `hostId` via `loadOwnedResidence`, which is the real authorization here.
hostRouter.use(requireAuth);
hostRouter.get("/:id/calendar", validate(getCalendarSchema), asyncHandler(controller.getHostCalendar));
hostRouter.patch("/:id/calendar", validate(updateCalendarSchema), asyncHandler(controller.updateCalendar));

export { publicRouter as publicCalendarRoutes, hostRouter as hostCalendarRoutes };
