import { NextFunction, Request, Response } from "express";
import { dropPublicCaches } from "@/lib/cache";

/**
 * Clears the public caches after any successful write from a panel.
 *
 * Mounted on the admin and host routers rather than wired into each service.
 * There are roughly forty mutating endpoints between them and more arriving;
 * a per-endpoint map of "which caches does this one touch" is a list that goes
 * stale the first time someone adds a route and forgets, and the failure is
 * silent — a stale page for the rest of the TTL, reported later as "the panel
 * saved but the site didn't change".
 *
 * The trade is over-invalidation: editing a user's phone number also drops the
 * home bundle. Panel writes are rare next to reads, and the caches rebuild off
 * one query each, so that costs far less than the bug it rules out.
 *
 * Runs on `finish`, after the response is on its way — the write has already
 * committed by then, and invalidation should not add latency to it.
 */
export function invalidateOnWrite(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }

  res.on("finish", () => {
    // A rejected write changed nothing, so there is nothing to forget.
    if (res.statusCode >= 400) return;
    void dropPublicCaches();
  });

  return next();
}
