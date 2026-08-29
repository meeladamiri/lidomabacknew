import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { cacheStatus, dropPublicCaches } from "@/lib/cache";

/**
 * Manual cache control.
 *
 * Invalidation is otherwise automatic — `middleware/cacheInvalidation.ts` drops
 * the public caches after any successful write under /api/admin or /api/host.
 * That covers everything done through the panel, and nothing else.
 *
 * It does not cover the migration and backfill scripts, which are how most of
 * this project's data arrived and which write to the database directly. After
 * `migrate-odoo-location-images.ts` filled in 402 city photographs, the popular
 * destinations endpoint went on serving `image: null` from a fifteen-minute
 * cache entry that had no idea anything had changed. Redis is on Liara's
 * private network, so a script on a developer's machine cannot clear it either.
 *
 * Mounted under the admin router, so it already requires an admin session.
 */
const router = Router();

router.post(
  "/purge",
  asyncHandler(async (_req, res) => {
    await dropPublicCaches();
    res.json({ status: "success", data: { purged: true, cache: cacheStatus() } });
  })
);

export default router;
