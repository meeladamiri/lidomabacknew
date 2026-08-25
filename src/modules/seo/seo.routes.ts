// Public SEO endpoints. The Next.js front proxies /sitemap.xml, /sitemaps/*
// and /robots.txt to these, so the files are served from the site root where
// crawlers expect them.

import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import * as sitemap from "./sitemap.service";

const router = Router();

// Sitemaps change as listings are published, but not by the minute. A short
// shared cache keeps a crawler burst off the database.
const CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

router.get(
  "/sitemap.xml",
  asyncHandler(async (_req, res) => {
    const settings = await sitemap.getSettings();
    if (!settings.sitemapEnabled || !settings.allowIndexing) {
      return res.status(404).type("text/plain").send("Not found");
    }
    res.setHeader("Cache-Control", CACHE);
    res.type("application/xml").send(await sitemap.renderIndex());
  })
);

// /sitemaps/<section>-<page>.xml
router.get(
  "/sitemaps/:file",
  asyncHandler(async (req, res) => {
    const settings = await sitemap.getSettings();
    if (!settings.sitemapEnabled || !settings.allowIndexing) {
      return res.status(404).type("text/plain").send("Not found");
    }

    // getFileUrls returns null for any name the index does not advertise, so
    // an invented file 404s instead of returning a valid but empty urlset.
    const urls = await sitemap.getFileUrls(req.params.file);
    if (!urls) return res.status(404).type("text/plain").send("Not found");

    res.setHeader("Cache-Control", CACHE);
    res.type("application/xml").send(sitemap.renderUrlSet(urls));
  })
);

router.get(
  "/robots.txt",
  asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    res.type("text/plain").send(await sitemap.renderRobots());
  })
);

export default router;
