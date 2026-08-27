// Admin CRUD for the location tree and the SEO tag system.
//
// Both feed every /search/<slug> and /search/<slug>?<tag>=1 page, all of which
// are indexed — so the write paths guard the things that would silently break
// SEO: duplicate slugs, cycles in the tree, and deletes that orphan listings.

import { Prisma, type LocationType, type ResidenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { invalidateSeoTagCache } from "@/lib/seoTags";

// ---------------------------------------------------------------- locations

export async function listLocations(params?: { q?: string; type?: LocationType }) {
  const where: Prisma.LocationWhereInput = {};
  if (params?.type) where.type = params.type;
  if (params?.q?.trim()) {
    const q = params.q.trim();
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { titleEn: { contains: q, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.location.findMany({
    where,
    select: {
      id: true,
      name: true,
      titleEn: true,
      type: true,
      parentId: true,
      canonicalId: true,
      isPublished: true,
      isPrimary: true,
      isActive: true,
      popularIndex: true,
      shomalIndex: true,
      sortOrder: true,
      imageUrl: true,
      latitude: true,
      longitude: true,
      keywords: true,
      odooId: true,
      _count: { select: { residences: true, extraResidences: true, children: true } },
    },
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return rows.map(({ _count, ...r }) => ({
    ...r,
    residenceCount: _count.residences,
    extraResidenceCount: _count.extraResidences,
    childCount: _count.children,
  }));
}

export async function getLocation(id: number) {
  const location = await prisma.location.findUnique({
    where: { id },
    include: {
      parent: { select: { id: true, name: true, type: true } },
      canonical: { select: { id: true, name: true, titleEn: true } },
      children: { select: { id: true, name: true, type: true }, orderBy: { name: "asc" } },
      includes: {
        include: { child: { select: { id: true, name: true, type: true, titleEn: true } } },
      },
      includedIn: { include: { parent: { select: { id: true, name: true, type: true } } } },
      seo: true,
      _count: { select: { residences: true, extraResidences: true } },
    },
  });
  if (!location) throw AppError.notFound("مکان یافت نشد");

  // Breadcrumb, root first. Guarded against a cycle — Odoo's tree had them.
  const breadcrumb: { id: number; name: string; type: LocationType }[] = [];
  const seen = new Set<number>();
  let cursor: { id: number; name: string; type: LocationType; parentId: number | null } | null = {
    id: location.id,
    name: location.name,
    type: location.type,
    parentId: location.parentId,
  };
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    breadcrumb.unshift({ id: cursor.id, name: cursor.name, type: cursor.type });
    cursor = cursor.parentId
      ? await prisma.location.findUnique({
          where: { id: cursor.parentId },
          select: { id: true, name: true, type: true, parentId: true },
        })
      : null;
  }

  return { ...location, breadcrumb };
}

/**
 * A slug is what every indexed URL is built from, so a duplicate silently
 * makes one of the two pages unreachable. Odoo shipped with real duplicates
 * (city and province both "isfahan"), so existing rows are left alone — but a
 * NEW clash is refused.
 */
async function assertSlugFree(titleEn: string | null | undefined, exceptId?: number) {
  const slug = titleEn?.trim();
  if (!slug) return;
  const clash = await prisma.location.findFirst({
    where: {
      titleEn: { equals: slug, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true },
  });
  if (clash) {
    throw AppError.badRequest(
      `اسلاگ «${slug}» قبلاً برای «${clash.name}» ثبت شده. اسلاگ تکراری باعث می‌شه یکی از دو صفحه در گوگل از دسترس خارج بشه.`
    );
  }
}

/** Walking up from parentId must never reach id. */
async function assertNoCycle(id: number, parentId: number | null | undefined) {
  if (!parentId) return;
  if (parentId === id) throw AppError.badRequest("یک مکان نمی‌تونه والد خودش باشه.");
  const seen = new Set<number>([id]);
  let cursor: number | null = parentId;
  while (cursor) {
    if (seen.has(cursor)) throw AppError.badRequest("این انتخاب توی درخت مکان‌ها حلقه می‌سازه.");
    seen.add(cursor);
    const row: { parentId: number | null } | null = await prisma.location.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = row?.parentId ?? null;
  }
}

export async function createLocation(data: any) {
  await assertSlugFree(data.titleEn);
  return prisma.location.create({
    data: {
      type: data.type,
      name: data.name,
      titleEn: data.titleEn?.trim() || null,
      parentId: data.parentId ?? null,
      canonicalId: data.canonicalId ?? null,
      imageUrl: data.imageUrl ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      keywords: data.keywords ?? null,
      isPublished: data.isPublished ?? true,
      isPrimary: data.isPrimary ?? false,
      isActive: data.isActive ?? true,
      popularIndex: data.popularIndex ?? null,
      shomalIndex: data.shomalIndex ?? null,
      sortOrder: data.sortOrder ?? 0,
    },
  });
}

const OPTIONAL_FIELDS = [
  "type", "name", "parentId", "canonicalId", "imageUrl", "latitude", "longitude",
  "keywords", "isPublished", "isPrimary", "isActive", "popularIndex",
  "shomalIndex", "sortOrder",
] as const;

export async function updateLocation(id: number, data: any) {
  if (data.titleEn !== undefined) await assertSlugFree(data.titleEn, id);
  if (data.parentId !== undefined) await assertNoCycle(id, data.parentId);
  if (data.canonicalId === id) throw AppError.badRequest("canonical نمی‌تونه به خود مکان اشاره کنه.");

  const patch: Record<string, unknown> = {};
  for (const f of OPTIONAL_FIELDS) if (data[f] !== undefined) patch[f] = data[f];
  if (data.titleEn !== undefined) patch.titleEn = data.titleEn?.trim() || null;

  return prisma.location.update({ where: { id }, data: patch });
}

/**
 * Refused while anything still points at the location — deleting one that has
 * listings 404s an indexed URL and orphans those listings. Unpublishing is the
 * reversible alternative and is what the UI suggests.
 */
export async function deleteLocation(id: number) {
  const row = await prisma.location.findUnique({
    where: { id },
    select: { _count: { select: { residences: true, children: true, extraResidences: true } } },
  });
  if (!row) throw AppError.notFound("مکان یافت نشد");
  const { residences, children, extraResidences } = row._count;
  if (residences || children || extraResidences) {
    throw AppError.badRequest(
      `این مکان قابل حذف نیست — ${residences} اقامتگاه اصلی، ${extraResidences} اقامتگاه فرعی و ${children} زیرمجموعه بهش وصله. اول اونا رو منتقل کن، یا به‌جای حذف، مکان رو «منتشرنشده» کن.`
    );
  }
  return prisma.location.delete({ where: { id } });
}

/** Replaces "شهرهای زیرمجموعه" for one location. */
export async function setLocationIncludes(id: number, childIds: number[]) {
  if (childIds.includes(id)) throw AppError.badRequest("یک مکان نمی‌تونه زیرمجموعه‌ی خودش باشه.");
  await prisma.locationInclude.deleteMany({ where: { parentId: id } });
  if (childIds.length) {
    await prisma.locationInclude.createMany({
      data: childIds.map((childId) => ({ parentId: id, childId })),
      skipDuplicates: true,
    });
  }
  return prisma.locationInclude.findMany({
    where: { parentId: id },
    include: { child: { select: { id: true, name: true, type: true, titleEn: true } } },
  });
}

/** Upserts one of the three SEO sets (default / بوم‌گردی / هتل) for a location. */
export async function upsertLocationSeo(
  locationId: number,
  residenceType: ResidenceType | null,
  data: any
) {
  const existing = await prisma.locationSeo.findFirst({ where: { locationId, residenceType } });
  const payload = {
    pageTitle: data.pageTitle ?? null,
    metaTitle: data.metaTitle ?? null,
    metaDescription: data.metaDescription ?? null,
    metaKeywords: data.metaKeywords ?? null,
    contentTitle: data.contentTitle ?? null,
    contentHtml: data.contentHtml ?? null,
    phone: data.phone ?? null,
    showPhone: data.showPhone ?? false,
    showPhoneFrom: data.showPhoneFrom ?? null,
    showPhoneTo: data.showPhoneTo ?? null,
    showInHomepage: data.showInHomepage ?? false,
    homepageIndex: data.homepageIndex ?? null,
  };
  return existing
    ? prisma.locationSeo.update({ where: { id: existing.id }, data: payload })
    : prisma.locationSeo.create({ data: { locationId, residenceType, ...payload } });
}

// ---------------------------------------------------------------- seo tags

export async function listSeoTags() {
  const tags = await prisma.seoTag.findMany({
    include: { conditions: true, _count: { select: { tagPages: true } } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return tags.map(({ _count, ...t }) => ({ ...t, pageCount: _count.tagPages }));
}

export async function getSeoTag(id: number) {
  const tag = await prisma.seoTag.findUnique({ where: { id }, include: { conditions: true } });
  if (!tag) throw AppError.notFound("تگ یافت نشد");
  return tag;
}

/**
 * The vocabulary a tag condition may reference. `options` are the categorical
 * values (نوع اقامتگاه / منطقه اقامتگاه) so the editor can offer a dropdown
 * instead of a free-text box that would silently never match.
 */
export async function getTagConditionOptions() {
  const [amenities, rules, usage, storedValues] = await Promise.all([
    prisma.amenity.findMany({
      where: { key: { not: null } },
      select: {
        id: true,
        key: true,
        name: true,
        category: true,
        features: { select: { name: true, values: true, fieldType: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.rule.findMany({
      where: { key: { not: null } },
      select: { id: true, key: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.residenceAmenity.groupBy({ by: ["amenityId"], _count: true }),
    // The values listings ACTUALLY carry. AmenityFeature.values does not hold
    // them for the categorical attributes — "نوع اقامتگاه" has no declared
    // option list, so without this the editor could not offer (or re-select)
    // "خانه ویلایی", which is exactly what the pool/villa/beach tags match on.
    prisma.$queryRawUnsafe<{ amenity_id: number; value: string }[]>(
      `SELECT DISTINCT ra.amenity_id, trim(part) AS value
         FROM residence_amenities ra,
              LATERAL unnest(string_to_array(ra.extra_features->>'value', '،')) AS part
        WHERE ra.extra_features->>'value' IS NOT NULL
          AND trim(part) <> ''
          AND trim(part) NOT IN ('دارد', 'ندارد')`
    ),
  ]);

  const usageByAmenity = new Map(usage.map((u) => [u.amenityId, u._count]));
  const valuesByAmenity = new Map<number, Set<string>>();
  for (const row of storedValues) {
    if (!valuesByAmenity.has(row.amenity_id)) valuesByAmenity.set(row.amenity_id, new Set());
    valuesByAmenity.get(row.amenity_id)!.add(row.value);
  }

  return {
    amenities: amenities.map((a) => {
      const declared = a.features
        .flatMap((f) => (f.values ?? "").split(","))
        .map((s) => s.trim())
        .filter((s) => s && s !== "دارد" && s !== "ندارد");
      const stored = [...(valuesByAmenity.get(a.id) ?? [])];
      return {
        id: a.id,
        key: a.key,
        name: a.name,
        category: a.category,
        usageCount: usageByAmenity.get(a.id) ?? 0,
        options: [...new Set([...stored, ...declared])].sort((x, y) => x.localeCompare(y, "fa")),
      };
    }),
    rules,
  };
}

async function assertTagKeyFree(key: string, exceptId?: number) {
  const clash = await prisma.seoTag.findFirst({
    where: { key: key.trim(), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (clash) throw AppError.badRequest(`کلید «${key}» قبلاً برای تگ «${clash.name}» ثبت شده.`);
}

function tagPayload(data: any) {
  return {
    key: data.key?.trim(),
    name: data.name,
    shortLabel: data.shortLabel ?? null,
    description: data.description ?? null,
    residenceType: data.residenceType ?? null,
    priceMin: data.priceMin ?? null,
    priceMax: data.priceMax ?? null,
    matchIsFast: data.matchIsFast ?? false,
    contentTitle: data.contentTitle ?? null,
    contentHtml: data.contentHtml ?? null,
    isActive: data.isActive ?? true,
    isSuggested: data.isSuggested ?? false,
    showInHomepage: data.showInHomepage ?? false,
    showInShomal: data.showInShomal ?? false,
    sortOrder: data.sortOrder ?? 0,
  };
}

async function replaceConditions(tagId: number, conditions: any[]) {
  await prisma.seoTagCondition.deleteMany({ where: { tagId } });
  if (!conditions.length) return;
  await prisma.seoTagCondition.createMany({
    data: conditions.map((c) => ({
      tagId,
      groupIndex: c.groupIndex ?? 0,
      amenityKey: c.amenityKey ?? null,
      ruleKey: c.ruleKey ?? null,
      valueName: c.valueName?.trim() || null,
    })),
  });
}

export async function createSeoTag(data: any) {
  await assertTagKeyFree(data.key);
  const tag = await prisma.seoTag.create({ data: tagPayload(data) });
  if (data.conditions?.length) await replaceConditions(tag.id, data.conditions);
  invalidateSeoTagCache();
  return getSeoTag(tag.id);
}

export async function updateSeoTag(id: number, data: any) {
  if (data.key) await assertTagKeyFree(data.key, id);
  await prisma.seoTag.update({ where: { id }, data: tagPayload(data) });
  if (data.conditions) await replaceConditions(id, data.conditions);
  invalidateSeoTagCache();
  return getSeoTag(id);
}

/**
 * Deleting a tag cascades to its curated tag pages, which are indexed — so it
 * refuses unless the caller explicitly confirms. Deactivating is the safe move.
 */
export async function deleteSeoTag(id: number, force = false) {
  const pages = await prisma.tagPage.count({ where: { tagId: id } });
  if (pages && !force) {
    throw AppError.badRequest(
      `این تگ ${pages} صفحه‌ی سئویی داره که با حذف تگ پاک می‌شن. اگه هدفت فقط از دسترس خارج‌کردنشه، «غیرفعال» کن.`
    );
  }
  const res = await prisma.seoTag.delete({ where: { id } });
  invalidateSeoTagCache();
  return res;
}

/**
 * Live preview for the tag editor: how many published listings a candidate
 * definition matches, before it is saved. Mirrors tagToWhere exactly.
 */
export async function previewSeoTag(body: {
  conditions?: any[];
  residenceType?: ResidenceType | null;
  priceMin?: number | null;
  priceMax?: number | null;
  matchIsFast?: boolean;
  locationId?: number | null;
}) {
  const clauses: Prisma.ResidenceWhereInput[] = [];

  const groups = new Map<number, any[]>();
  for (const c of body.conditions ?? []) {
    const g = c.groupIndex ?? 0;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
  for (const conds of groups.values()) {
    const alts: Prisma.ResidenceWhereInput[] = conds.map((c) =>
      c.ruleKey
        ? { rules: { some: { rule: { key: c.ruleKey }, value: { equals: "بله" } } } }
        : {
            amenities: {
              some: {
                amenity: { key: c.amenityKey ?? "" },
                ...(c.valueName
                  ? { extraFeatures: { path: ["value"], string_contains: c.valueName } }
                  : {}),
              },
            },
          }
    );
    if (alts.length) clauses.push(alts.length === 1 ? alts[0] : { OR: alts });
  }
  if (body.residenceType) clauses.push({ type: body.residenceType });
  if (body.matchIsFast) clauses.push({ isFast: true });
  if (body.priceMin != null || body.priceMax != null) {
    clauses.push({
      weekPrice: {
        ...(body.priceMin != null ? { gt: body.priceMin } : {}),
        ...(body.priceMax != null ? { lte: body.priceMax } : {}),
      },
    });
  }

  const where: Prisma.ResidenceWhereInput = {
    state: "PUBLISHED",
    published: true,
    ...(clauses.length ? { AND: clauses } : {}),
    ...(body.locationId ? { locationId: body.locationId } : {}),
  };

  const [total, sample] = await Promise.all([
    prisma.residence.count({ where }),
    prisma.residence.findMany({
      where,
      select: { id: true, name: true, location: { select: { name: true } } },
      take: 8,
    }),
  ]);
  return { total, sample };
}

// ---------------------------------------------------------------- tag pages

export async function listTagPages(params: {
  locationId?: number;
  tagId?: number;
  q?: string;
  onlyActive?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 50, 200);

  const where: Prisma.TagPageWhereInput = {};
  if (params.locationId) where.locationId = params.locationId;
  if (params.tagId) where.tagId = params.tagId;
  if (params.onlyActive) where.isActive = true;
  if (params.q?.trim()) {
    const q = params.q.trim();
    where.OR = [
      { metaTitle: { contains: q, mode: "insensitive" } },
      { location: { name: { contains: q, mode: "insensitive" } } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.tagPage.count({ where }),
    prisma.tagPage.findMany({
      where,
      include: {
        location: { select: { id: true, name: true, titleEn: true, type: true } },
        tag: { select: { id: true, key: true, name: true } },
      },
      orderBy: [{ residenceCount: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, items };
}

export async function createTagPage(data: any) {
  const dup = await prisma.tagPage.findFirst({
    where: { locationId: data.locationId ?? null, tagId: data.tagId ?? null },
  });
  if (dup) throw AppError.badRequest("برای این ترکیب مکان و تگ، از قبل یک صفحه وجود داره.");
  return prisma.tagPage.create({
    data: {
      locationId: data.locationId ?? null,
      tagId: data.tagId ?? null,
      metaTitle: data.metaTitle ?? null,
      metaDescription: data.metaDescription ?? null,
      metaKeywords: data.metaKeywords ?? null,
      contentTitle: data.contentTitle ?? null,
      contentHtml: data.contentHtml ?? null,
      showInSitemap: data.showInSitemap ?? false,
      isActive: data.isActive ?? true,
    },
  });
}

export async function updateTagPage(id: number, data: any) {
  const patch: Record<string, unknown> = {};
  for (const f of [
    "metaTitle", "metaDescription", "metaKeywords", "contentTitle",
    "contentHtml", "showInSitemap", "isActive",
  ] as const) {
    if (data[f] !== undefined) patch[f] = data[f];
  }
  return prisma.tagPage.update({
    where: { id },
    data: patch,
    include: {
      location: { select: { id: true, name: true, titleEn: true } },
      tag: { select: { id: true, key: true, name: true } },
    },
  });
}

export async function deleteTagPage(id: number) {
  return prisma.tagPage.delete({ where: { id } });
}
