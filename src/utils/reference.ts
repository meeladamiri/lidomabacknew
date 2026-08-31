import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Generates a short, human-friendly, unique-ish reference code
 * (e.g. for residences and reservations), similar in spirit to the
 * public "reference" codes used throughout the old system.
 */
export function generateReference(prefix: string): string {
  const random = crypto.randomInt(0, 999999).toString().padStart(6, "0");
  const timePart = Date.now().toString(36).toUpperCase().slice(-4);
  return `${prefix}${timePart}${random}`;
}

/**
 * The next booking code, continuing the `SO` series the business already uses.
 *
 * New bookings used to get `RSV-M7X2123456` from the random generator above,
 * so the panel carried two unrelated code shapes and a new code could not be
 * read back to a host who has only ever seen `SO369973`. The 29,643 codes
 * migrated from Odoo are that series; this carries on from the highest of
 * them.
 *
 * A Postgres sequence rather than `MAX(reference) + 1`: two bookings created
 * in the same moment would otherwise compute the same number, and `reference`
 * is unique — the loser's insert fails for a reason the guest cannot act on.
 * `nextval` is atomic and never hands the same number out twice.
 *
 * Takes the transaction client when there is one, so the code is drawn inside
 * the same transaction that creates the booking.
 */
export async function nextReservationReference(
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT nextval('reservation_reference_seq') AS n`
  );
  return `SO${rows[0].n}`;
}
