// Public SEO endpoints. The Next.js front proxies /sitemap.xml, /sitemaps/*
// and /robots.txt to these, so the files are served from the site root where
// crawlers expect them.

import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { cached, TTL } from "@/lib/cache";
import * as sitemap from "./sitemap.service";

const router = Router();

// Sitemaps change as listings are published, but not by the minute. A short
// shared cache keeps a crawler burst off the database.
const CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

// Read on every one of these routes purely to decide whether to answer at all,
// so it is worth not paying a query for it each time.
const cachedSettings = () =>
  cached("sitemap:settings", TTL.sitemap, () => sitemap.getSettings());

router.get(
  "/sitemap.xml",
  asyncHandler(async (_req, res) => {
    const settings = await cachedSettings();
    if (!settings.sitemapEnabled || !settings.allowIndexing) {
      return res.status(404).type("text/plain").send("Not found");
    }
    res.setHeader("Cache-Control", CACHE);
    const xml = await cached("sitemap:index", TTL.sitemap, () => sitemap.renderIndex());
    res.type("application/xml").send(xml);
  })
);

// /sitemaps/<section>-<page>.xml
router.get(
  "/sitemaps/:file",
  asyncHandler(async (req, res) => {
    const settings = await cachedSettings();
    if (!settings.sitemapEnabled || !settings.allowIndexing) {
      return res.status(404).type("text/plain").send("Not found");
    }

    // getFileUrls returns null for any name the index does not advertise, so
    // an invented file 404s instead of returning a valid but empty urlset.
    // That null is cached too — otherwise a crawler walking dead sitemap links
    // costs a query every time — but only for names shaped like a real sitemap
    // file, so the cached 404s cannot themselves become the flood.
    const file = req.params.file;
    const key = /^[a-z0-9-]{1,64}.xml$/i.test(file) ? `sitemap:file:${file}` : null;
    const xml = await cached(key, TTL.sitemap, async () => {
      const urls = await sitemap.getFileUrls(file);
      return urls ? sitemap.renderUrlSet(urls) : null;
    });
    if (!xml) return res.status(404).type("text/plain").send("Not found");

    res.setHeader("Cache-Control", CACHE);
    res.type("application/xml").send(xml);
  })
);

router.get(
  "/robots.txt",
  asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    const body = await cached("sitemap:robots", TTL.sitemap, () => sitemap.renderRobots());
    res.type("text/plain").send(body);
  })
);

export default router;
