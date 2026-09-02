import { z } from "zod";

/**
 * Numbers that arrive as strings.
 *
 * Every numeric field in the submission wizard is typed into a text input,
 * and a controlled text input holds a string. So `totalArea` left the browser
 * as `"120"`, `z.number()` rejected it, and the whole request came back as
 * «ورودی نامعتبر است» — naming no field, because the message is the
 * middleware's, not the schema's. One string in a body of fifteen values
 * failed the other fourteen with it.
 *
 * That is what stopped **every new listing** at the specs step. The front is
 * fixed to send real numbers, but the coercion belongs here too: this is the
 * boundary, and a host on a Persian keyboard typing ۱۲۰ is not sending a
 * different number than one typing 120.
 *
 * Note what this deliberately does not do: it does not accept nonsense. A
 * value that is not a number after folding is handed to zod untouched, so the
 * error still says what was wrong with it. This widens the accepted spelling
 * of a number, not the definition of one.
 */

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/** ۱۲۳ and ١٢٣ are both 123. */
export function foldDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) out += code - PERSIAN_ZERO;
    else if (code >= ARABIC_ZERO && code <= ARABIC_ZERO + 9) out += code - ARABIC_ZERO;
    else out += ch;
  }
  return out;
}

/**
 * Strips what a person types around a number and leaves the number.
 *
 * Thousands separators go — both the ASCII comma and the Arabic one (U+066C)
 * that a Persian keyboard produces. An empty field becomes `undefined` rather
 * than `0`: a host who cleared the area box is saying they do not know it,
 * which is not the same as saying it is zero square metres.
 */
function coerce(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") return value;

  const cleaned = foldDigits(value)
    .replace(/[\s,\u066C\u060C]/g, "")
    .trim();
  if (cleaned === "") return undefined;

  const parsed = Number(cleaned);
  // Not a number: hand the original back so zod reports it, rather than
  // silently turning "abc" into NaN or dropping the field.
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * `numeric(z.number().min(0)).optional()` — same schema, wider spelling.
 *
 * The inner schema is made optional here rather than left to the caller.
 * `.optional()` on the outside only guards against an input that is already
 * undefined, and a cleared text box does not send undefined — it sends "".
 * Without this, emptying the area field failed with «Required» on a field the
 * host had deliberately left blank.
 */
export function numeric<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(coerce, schema.optional());
}
