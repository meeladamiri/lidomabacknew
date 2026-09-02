import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";

/**
 * «نوع اقامتگاه» و «منطقه اقامتگاه».
 *
 * Both are real taxonomies carried over from Odoo, and both live in the
 * amenities system rather than on the residence row: the amenity keyed `type`
 * on 8,689 listings, and `area` on 8,518. The SEO tag engine reads exactly
 * these — `seo_tag_conditions` matches on `amenity_key = 'type' | 'area'` —
 * so «اجاره ویلا و سوئیت ساحلی» is a page that exists because listings carry
 * `area = ساحلی`.
 *
 * The residence table's own `region` and `rentType` columns look like the
 * same thing and are not: three listings each, no reader anywhere. They were
 * free-text boxes in the panel that wrote to nothing anyone consults.
 *
 * Written through here rather than `updateAmenities`, which deletes every
 * amenity and recreates the list it is given — sending two would drop the
 * other twenty-five.
 */

export const CLASSIFICATION_KEYS = ["type", "area"] as const;
export type ClassificationKey = (typeof CLASSIFICATION_KEYS)[number];

/**
 * The option lists alone, with no listing in hand.
 *
 * The host wizard asks this on its first screen, before a residence row
 * exists to attach answers to.
 */
export async function getClassificationOptions() {
  const amenities = await prisma.amenity.findMany({
    where: { key: { in: [...CLASSIFICATION_KEYS] } },
    select: { id: true, key: true, name: true },
  });
  return { fields: await optionsFor(amenities) };
}

async function optionsFor(amenities: { id: number; key: string | null; name: string }[]) {
  const fields: { key: string; name: string; options: string[] }[] = [];
  for (const amenity of amenities) {
    if (!amenity.key) continue;
    const rows = await prisma.$queryRawUnsafe<{ v: string; c: bigint }[]>(
      `SELECT extra_features->>'value' AS v, COUNT(*)::bigint AS c
       FROM residence_amenities
       WHERE amenity_id = $1 AND extra_features->>'value' IS NOT NULL
       GROUP BY 1`,
      amenity.id
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const part of (row.v ?? "").split("،")) {
        const value = part.trim();
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + Number(row.c));
      }
    }
    fields.push({
      key: amenity.key,
      name: amenity.name,
      options: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value),
    });
  }
  return fields;
}

export async function getClassification(residenceId: number) {
  const amenities = await prisma.amenity.findMany({
    where: { key: { in: [...CLASSIFICATION_KEYS] } },
    select: { id: true, key: true, name: true },
  });

  const current = await prisma.residenceAmenity.findMany({
    where: { residenceId, amenityId: { in: amenities.map((a) => a.id) } },
    select: { amenityId: true, extraFeatures: true },
  });

  // The catalogue has no fixed value list for either, so the options are the
  // values the estate actually uses. Comma-joined rows are split back out:
  // «شهری، ساحلی» is two answers, not a ninth option.
  const options: Record<string, string[]> = {};
  for (const amenity of amenities) {
    // `key` is nullable on the model; these two always have one, but the
    // compiler is right that the catalogue does not guarantee it.
    if (!amenity.key) continue;
    const rows = await prisma.$queryRawUnsafe<{ v: string; c: bigint }[]>(
      `SELECT extra_features->>'value' AS v, COUNT(*)::bigint AS c
       FROM residence_amenities
       WHERE amenity_id = $1 AND extra_features->>'value' IS NOT NULL
       GROUP BY 1`,
      amenity.id
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      // A NULL survives the WHERE when the JSON key is present but null, so
      // the split is guarded rather than assumed.
      for (const part of (row.v ?? "").split("،")) {
        const value = part.trim();
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + Number(row.c));
      }
    }

    options[amenity.key] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value]) => value);
  }

  const valueOf = (key: string) => {
    const amenity = amenities.find((a) => a.key === key);
    if (!amenity) return null;
    const row = current.find((c) => c.amenityId === amenity.id);
    const raw = (row?.extraFeatures as { value?: string } | null)?.value;
    return raw ? raw.split("،").map((s) => s.trim()).filter(Boolean) : [];
  };

  return {
    fields: amenities.map((a) => ({
      key: a.key,
      name: a.name,
      options: a.key ? (options[a.key] ?? []) : [],
      selected: a.key ? (valueOf(a.key) ?? []) : [],
    })),
  };
}

export async function setClassification(input: {
  residenceId: number;
  key: ClassificationKey;
  values: string[];
  actorId: number;
}) {
  const amenity = await prisma.amenity.findFirst({
    where: { key: input.key },
    select: { id: true, name: true },
  });
  if (!amenity) throw AppError.notFound("این دسته‌بندی در فهرست امکانات تعریف نشده است");

  const residence = await prisma.residence.findUnique({
    where: { id: input.residenceId },
    select: { id: true, name: true },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const clean = [...new Set(input.values.map((v) => v.trim()).filter(Boolean))];
  const value = clean.join("، ");

  const existing = await prisma.residenceAmenity.findFirst({
    where: { residenceId: input.residenceId, amenityId: amenity.id },
    select: { id: true, extraFeatures: true },
  });

  const before = (existing?.extraFeatures as { value?: string } | null)?.value ?? "";

  if (clean.length === 0) {
    // Nothing selected means the listing has no answer, which is different
    // from an empty string sitting where an answer should be.
    if (existing) await prisma.residenceAmenity.delete({ where: { id: existing.id } });
  } else if (existing) {
    await prisma.residenceAmenity.update({
      where: { id: existing.id },
      data: { extraFeatures: { ...(existing.extraFeatures as object), value } },
    });
  } else {
    await prisma.residenceAmenity.create({
      data: { residenceId: input.residenceId, amenityId: amenity.id, extraFeatures: { value } },
    });
  }

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: input.residenceId,
    summary: `«${amenity.name}» اقامتگاه «${residence.name}» از «${before || "—"}» به «${value || "—"}» تغییر کرد`,
    details: { key: input.key, before, after: value } as never,
    actorId: input.actorId,
    source: "CLASSIFICATION",
  });

  return { key: input.key, values: clean };
}
