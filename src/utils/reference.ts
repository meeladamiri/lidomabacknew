import crypto from "crypto";

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
