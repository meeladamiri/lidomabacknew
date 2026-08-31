/**
 * The host's own house rules, out of whatever Odoo left in `rulesDesc`.
 *
 * Odoo stored one JSON blob per listing: a map of rule id → note, plus a
 * top-level `desc` holding the free-text rules the host wrote. The migration
 * copied that blob into `rulesDesc` verbatim, so 2,555 of the 2,557 listings
 * that have the column carry something like
 *
 *   {"244": "", "245": {"desc": "..."}, "desc": "لطفا با کفش وارد نشوید"}
 *
 * and 1,144 of them carry it with `\uXXXX` escapes on top. The panel put that
 * straight into the «قوانین میزبان» box, which meant an agent opening the
 * rules tab saw a wall of JSON — and saving would have written the wall back.
 *
 * Anything that does not parse as an object is already plain text and is
 * returned untouched, which is what the two remaining listings need.
 */
export function hostRulesText(
  rulesDesc: string | null | undefined,
  extraRules?: unknown
): string {
  const raw = rulesDesc?.trim();

  if (raw && (raw.startsWith("{") || raw.startsWith("["))) {
    const fromBlob = descOf(safeParse(raw));
    if (fromBlob) return fromBlob;
    // Parsed, but carries no host text — the blob was only per-rule notes.
    // Falling through to `extraRules` rather than returning the blob.
  } else if (raw) {
    return raw;
  }

  return descOf(extraRules) ?? "";
}

/**
 * The per-rule notes a host attached to individual rules, keyed by the rule id
 * Odoo used. Kept separate from the free text because they answer a different
 * question — "what did they say about pets" rather than "what are the rules".
 */
export function hostRuleNotes(
  rulesDesc: string | null | undefined,
  extraRules?: unknown
): Record<string, string> {
  const source =
    rulesDesc?.trim().startsWith("{") ? safeParse(rulesDesc.trim()) : (extraRules ?? null);
  if (!isRecord(source)) return {};

  const notes: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "desc") continue;
    const text = typeof value === "string" ? value : descOf(value);
    if (text && text.trim()) notes[key] = text.trim();
  }
  return notes;
}

function safeParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function descOf(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  const desc = v.desc;
  return typeof desc === "string" && desc.trim() ? desc.trim() : undefined;
}
