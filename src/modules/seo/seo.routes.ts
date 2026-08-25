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

    const m = /^(.+)-(\d+)\.xml$/.exec(req.params.file);
    if (!m) return res.status(404).type("text/plain").send("Not found");

    const key = m[1] as sitemap.SectionKey;
    const page = Number(m[2]);

    // Only serve a chunk the index actually advertises — otherwise
    // /sitemaps/locations-999.xml would return a valid but empty urlset.
    const entries = await sitemap.getIndexEntries();
    if (!entries.some((e) => e.key === key && e.page === page)) {
      return res.status(404).type("text/plain").send("Not found");
    }

    const urls = await sitemap.getSectionPage(key, page);
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
