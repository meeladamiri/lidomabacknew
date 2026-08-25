-- tag-pages: let the admin stop honouring Odoo's x_show_in_sitemap flag, which
-- was true for only 58 of 9,312 pages and otherwise caps the sitemap at 14 URLs.
ALTER TABLE "sitemap_sections"
  ADD COLUMN "require_sitemap_flag" BOOLEAN NOT NULL DEFAULT true;
