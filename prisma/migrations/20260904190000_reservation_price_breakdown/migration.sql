-- The guest invoice folded every night into one line because nothing kept
-- the itemized weekday/weekend/peak/special breakdown calculateStayPrice()
-- already computes at booking (and reprice) time — only the final
-- totalAmount was ever persisted. This column stores that breakdown as JSON
-- so the guest-facing checkout can show real per-category rows instead of
-- guessing from current calendar rates, which would misstate history for
-- any stay whose prices later changed. Nullable and purely additive — old
-- reservations render with the previous folded-line fallback.
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "price_breakdown" JSONB;
