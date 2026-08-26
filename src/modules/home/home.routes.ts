// Public home-page endpoint. One call returns the whole page: the old site
// made five (get_items plus four slider calls), which serialised five round
// trips before anything below the hero could render.

import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { ok } from "@/utils/response";
import { getHomePageData } from "./home.service";

const router = Router();

router.get(
  "/page-data",
  asyncHandler(async (_req, res) => {
    // Curated content changes rarely; a short shared cache keeps the home page
    // off the database for the common case while staying fresh enough that an
    // admin edit shows up within the minute.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
    return ok(res, await getHomePageData());
  })
);

export default router;
