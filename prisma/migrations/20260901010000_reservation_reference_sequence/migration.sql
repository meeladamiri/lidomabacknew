-- Continue the SO series that the business already uses.
--
-- New bookings were getting `RSV-M7X2123456` from a random generator, which
-- meant the panel showed two unrelated code shapes and nobody could read a new
-- code back to a host who has only ever seen `SO369973`.
--
-- A sequence rather than MAX(reference)+1 at insert time: two bookings created
-- in the same moment would otherwise compute the same number, and `reference`
-- is unique — the second insert would fail for a reason the guest cannot act
-- on.
--
-- Seeded from the highest existing SO code so the series simply continues.

CREATE SEQUENCE IF NOT EXISTS reservation_reference_seq;

SELECT setval(
  'reservation_reference_seq',
  GREATEST(
    COALESCE(
      (SELECT MAX(NULLIF(regexp_replace(reference, '^SO', ''), '')::bigint)
       FROM reservations
       WHERE reference ~ '^SO[0-9]+$'),
      0
    ),
    1
  )
);
