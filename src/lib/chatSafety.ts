/**
 * What a message body is allowed to be, and what is worth flagging in it.
 *
 * Two separate jobs. Normalising is about storage: one canonical form, bounded
 * length, no control characters. Flagging is about the business: a host and a
 * guest agreeing to settle off the platform costs the site its commission and
 * leaves a booking support cannot stand behind, which is why Airbnb masks
 * contact details until a reservation is confirmed.
 *
 * Flagging never blocks. A false positive that swallowed a real message would
 * be far worse than one the panel glances at — people do legitimately swap
 * arrival times that look like phone numbers. The strict version (mask before
 * confirmation) is left as a decision rather than taken here.
 */

export const MAX_MESSAGE_LENGTH = 4000;

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/** Persian and Arabic digits fold to ASCII so one pattern covers all three. */
function foldDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO;
    return String(code - base);
  });
}

/**
 * Storage form: trimmed, control characters gone, runs of blank lines
 * collapsed, and capped.
 *
 * Zero-width characters are stripped rather than kept — they are invisible to
 * the reader and the obvious way to slip a phone number past a filter.
 */
export function normalizeBody(raw: string): string {
  const stripped = Array.from(raw)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (code === 10) return true; // newlines are the one control char we keep
      if (code < 32 || code === 127) return false;
      // Zero-width joiners and the BOM: invisible, and the obvious way to
      // break a phone number up so the pattern below misses it.
      return !(code >= 0x200b && code <= 0x200d) && code !== 0xfeff;
    })
    .join("");

  return stripped
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

const SEP = "[\\s.\\-_]*";

const PATTERNS: RegExp[] = [
  // An Iranian mobile number, however it is spaced or punctuated.
  new RegExp(`0?9${SEP}` + `\\d${SEP}`.repeat(8)),
  // +98 / 0098 prefixes.
  /(\+|00)\s*98\s*9\d/,
  // A landline with an area code.
  /0\d{2}[\s.\-]?\d{4}[\s.\-]?\d{4}/,
  // Messenger names, in either script.
  /(telegram|whatsapp|whats\s?app|instagram|eitaa|rubika|t\.me|wa\.me)/i,
  /(تلگرام|واتس\s?اپ|واتساپ|اینستا|ایتا|روبیکا|سروش|آیدی|ایدی)/,
  // An @handle long enough to be one.
  /(^|\s)@[A-Za-z0-9_]{4,}/,
  // A bare email address.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

/**
 * True when the body looks like an attempt to move the conversation off the
 * platform. Digits are folded first, so a number written in Persian digits is
 * caught alongside the same number in ASCII.
 */
export function looksOffPlatform(body: string): boolean {
  const folded = foldDigits(body);
  return PATTERNS.some((pattern) => pattern.test(folded));
}

/** The one-line form the conversation list shows. */
export function previewOf(body: string, type: string): string {
  if (type === "IMAGE") return "🖼 تصویر";
  if (type === "FILE") return "📎 فایل";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
