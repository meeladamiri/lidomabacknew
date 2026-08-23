// "نوع ملک" — the residence's own category (independent of the city
// taxonomy), migrated from legacy Odoo product_template.x_display_type.
// Every place that renders or filters by type goes through here so adding a
// fourth type later is a one-file change.
import type { ResidenceType } from "@/generated/prisma/client";

export const RESIDENCE_TYPES = ["SUIT", "BOOMGARDI", "HOTEL"] as const;

/** Legacy Odoo/front-end slug (`display_type`) for a stored type. */
export const RESIDENCE_TYPE_SLUG: Record<ResidenceType, "suit" | "boomgardi" | "hotel"> = {
  SUIT: "suit",
  BOOMGARDI: "boomgardi",
  HOTEL: "hotel",
};

/** Persian label used in UI copy ("امکانات __", "__ به میزبانی: "). */
export const RESIDENCE_TYPE_LABEL: Record<ResidenceType, string> = {
  SUIT: "سوئیت",
  BOOMGARDI: "بوم‌گردی",
  HOTEL: "هتل",
};

export function slugToResidenceType(slug: string | undefined): ResidenceType | undefined {
  const found = (Object.keys(RESIDENCE_TYPE_SLUG) as ResidenceType[]).find(
    (t) => RESIDENCE_TYPE_SLUG[t] === slug
  );
  return found;
}
