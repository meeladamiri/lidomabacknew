import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import { env, isProd } from "@/config/env";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import { UPLOAD_ROOT } from "@/middleware/upload";

import authRoutes from "@/modules/auth/auth.routes";
import usersRoutes from "@/modules/users/users.routes";
import residencesRoutes from "@/modules/residences/residences.routes";
import hostResidencesRoutes from "@/modules/residences/host.routes";
import searchRoutes from "@/modules/search/search.routes";
import favouritesRoutes from "@/modules/favourites/favourites.routes";
import { publicCalendarRoutes, hostCalendarRoutes } from "@/modules/calendar/calendar.routes";
import { guestReservationRoutes, hostReservationRoutes } from "@/modules/reservations/reservations.routes";
import adminRoutes from "@/modules/admin/admin.routes";
import seoRoutes from "@/modules/seo/seo.routes";
import homeRoutes from "@/modules/home/home.routes";

export function buildApp() {
  const app = express();

  // crossOriginResourcePolicy defaults to "same-origin", which would block the
  // Next.js frontend (a different origin) from loading /uploads images.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    })
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProd ? "combined" : "dev"));
  app.use("/uploads", express.static(UPLOAD_ROOT));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Public
  // Served from the site root (the front proxies them there) so crawlers find
  // /sitemap.xml and /robots.txt where they expect.
  app.use(seoRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/home", homeRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/residences", residencesRoutes);
  app.use("/api/residences", publicCalendarRoutes); // GET /:id/calendar

  // Authenticated (guest)
  app.use("/api/users", usersRoutes);
  app.use("/api/favourites", favouritesRoutes);
  app.use("/api/reservations", guestReservationRoutes);

  // Host
  app.use("/api/host/residences", hostResidencesRoutes);
  app.use("/api/host/residences", hostCalendarRoutes); // PATCH /:id/calendar
  app.use("/api/host/reservations", hostReservationRoutes);

  // Admin
  app.use("/api/admin", adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
