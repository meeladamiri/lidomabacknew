-- Page views per listing, per day.
--
-- The panel asks for "بازدید ماهانه یک سال اخیر" and "روزانه یک ماه اخیر".
-- Neither could be answered, because nothing has ever recorded a view:
--
--   • the current schema has no view table at all;
--   • Odoo's `res_users_viewed_products` holds 213,782 rows, but its newest
--     is 2021-06-07 and its `count` column is null on every single one. It is
--     five-year-old history from a site that no longer runs.
--
-- So the year of history that was asked for cannot be produced. What can be
-- done is to start counting, which is what this table does — a month from now
-- the daily chart is real, and a year from now the monthly one is.
--
-- One row per (listing, day) with a counter, not one row per view. At this
-- catalogue's size a row per view is millions a month to answer a question
-- that only ever asks for daily and monthly totals. The counter gives both by
-- summing, and costs one upsert per page render.
--
-- This counts page renders, not people: the same visitor refreshing counts
-- twice. Distinguishing them needs per-visitor rows, which is the design this
-- one deliberately is not — so the panel says «بازدید» and never «بازدیدکننده».

CREATE TABLE IF NOT EXISTS "residence_views" (
  "residence_id" INTEGER NOT NULL,
  "date"         DATE    NOT NULL,
  "count"        INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "residence_views_pkey" PRIMARY KEY ("residence_id", "date")
);

-- Charts read one listing over a date range, which the primary key already
-- serves. This second index is for the other direction — "busiest listings
-- last month" on the dashboard.
CREATE INDEX IF NOT EXISTS "residence_views_date_idx" ON "residence_views" ("date");

ALTER TABLE "residence_views"
  ADD CONSTRAINT "residence_views_residence_id_fkey"
  FOREIGN KEY ("residence_id") REFERENCES "residences"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
