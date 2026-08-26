// "سوالات متداول" — resolution and admin CRUD.
//
// A page asks "which questions apply to me?" and gets back the union of every
// scope that matches, ordered from the most specific to the most general. So a
// question written for شیراز sits above the generic search-page set on
// /search/shiraz, and a question written for شیراز×استخردار sits above both on
// /search/shiraz?pool=1.
//
// Answers are rendered as FAQPage JSON-LD, so what is written here is what
// Google may show as a rich result — which is why the admin screen shows the
// resolved list for a real page rather than just the raw rows.

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import type { Faq, FaqScope } from "@/generated/prisma/client";

/** Most specific first — this is the order questions render in. */
const SCOPE_RANK: Record<FaqScope, number> = {
  TAG_LOCATION: 0,
  LOCATION: 1,
  TAG: 2,
  PAGE: 3,
  RESIDENCE: 4,
  SEARCH: 5,
  GLOBAL: 6,
};

export interface FaqPageContext {
  /** Resolved location for a /search page, if any. */
  locationId?: number | null;
  locationName?: string | null;
  /** Active tag on the page, if any. */
  tagId?: number | null;
  tagName?: string | null;
  /** Which family of page this is. */
  kind: "search" | "residence" | "page";
  /** Exact path, for PAGE-scoped questions. */
  path?: string | null;
}

const SITE_NAME = "لیدوماتریپ";

/**
 * Fills {location} / {tag} / {site}. A question that names a placeholder with
 * nothing to fill is DROPPED rather than rendered with a hole in it — the
 * nationwide /search?pool=1 page has no location, and
 * "اقامتگاه رزرو کنم در ؟" would be worse than showing one question fewer.
 */
function interpolate(text: string, ctx: FaqPageContext): string | null {
  const values: Record<string, string | null | undefined> = {
    location: ctx.locationName,
    tag: ctx.tagName,
    site: SITE_NAME,
  };
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = values[key];
    if (!v) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}

export async function getFaqsForPage(ctx: FaqPageContext) {
  const scopes: FaqScope[] = ["GLOBAL"];
  if (ctx.kind === "search") scopes.push("SEARCH");
  if (ctx.kind === "residence") scopes.push("RESIDENCE");

  const where: any[] = [{ scope: { in: scopes } }];
  if (ctx.locationId)
    where.push({ scope: "LOCATION", locationId: ctx.locationId });
  if (ctx.tagId) where.push({ scope: "TAG", tagId: ctx.tagId });
  if (ctx.locationId && ctx.tagId) {
    where.push({
      scope: "TAG_LOCATION",
      locationId: ctx.locationId,
      tagId: ctx.tagId,
    });
  }
  if (ctx.path) where.push({ scope: "PAGE", path: ctx.path });

  const rows = await prisma.faq.findMany({
    where: { isActive: true, OR: where },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  return rows
    .sort(
      (a, b) =>
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        a.sortOrder - b.sortOrder ||
        a.id - b.id,
    )
    .map((f) => {
      const question = interpolate(f.question, ctx);
      const answer = interpolate(f.answer, ctx);
      if (!question || !answer) return null;
      return { id: f.id, question, answer };
    })
    .filter((f): f is { id: number; question: string; answer: string } => !!f);
}

// ---------------------------------------------------------------- admin

export async function listFaqs(params: {
  scope?: FaqScope;
  locationId?: number;
  tagId?: number;
  path?: string;
  q?: string;
}) {
  const where: any = {};
  if (params.scope) where.scope = params.scope;
  if (params.locationId) where.locationId = params.locationId;
  if (params.tagId) where.tagId = params.tagId;
  // PAGE-scoped rows are keyed by path; without this a caller asking for the
  // home page ("/") gets every PAGE question on the site.
  if (params.path) where.path = params.path;
  if (params.q?.trim()) {
    const q = params.q.trim();
    where.OR = [
      { question: { contains: q, mode: "insensitive" } },
      { answer: { contains: q, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.faq.findMany({
    where,
    include: {
      location: { select: { id: true, name: true, titleEn: true } },
      tag: { select: { id: true, key: true, name: true } },
    },
    orderBy: [{ scope: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
  return rows;
}

/**
 * The resolved list for a real page — what a visitor would actually see. This
 * is the "filter by page" the admin screen leads with, because the raw rows do
 * not tell you what any given page ends up showing.
 */
export async function previewFaqsForPage(params: {
  slug?: string;
  tagKey?: string;
  kind?: string;
  path?: string;
}) {
  let locationId: number | null = null;
  let locationName: string | null = null;
  let tagId: number | null = null;
  let tagName: string | null = null;

  if (params.slug) {
    const { resolveLocationBySlug } = await import("@/lib/location");
    const loc = await resolveLocationBySlug(params.slug);
    locationId = loc?.id ?? null;
    locationName = loc?.name ?? null;
  }
  if (params.tagKey) {
    const tag = await prisma.seoTag.findUnique({
      where: { key: params.tagKey },
    });
    tagId = tag?.id ?? null;
    tagName = tag?.name ?? null;
  }

  const kind = (params.kind as FaqPageContext["kind"]) || "search";
  const faqs = await getFaqsForPage({
    locationId,
    locationName,
    tagId,
    tagName,
    kind,
    path: params.path ?? null,
  });

  return {
    context: {
      locationId,
      locationName,
      tagId,
      tagName,
      kind,
      path: params.path ?? null,
    },
    faqs,
  };
}

function assertScopeTarget(data: any) {
  const scope: FaqScope = data.scope;
  if ((scope === "LOCATION" || scope === "TAG_LOCATION") && !data.locationId) {
    throw AppError.badRequest("برای این محدوده باید یک مکان انتخاب کنی.");
  }
  if ((scope === "TAG" || scope === "TAG_LOCATION") && !data.tagId) {
    throw AppError.badRequest("برای این محدوده باید یک تگ انتخاب کنی.");
  }
  if (scope === "PAGE" && !data.path?.trim()) {
    throw AppError.badRequest(
      "برای محدوده‌ی «یک صفحه‌ی مشخص» باید مسیر صفحه رو بنویسی.",
    );
  }
}

/** Only the fields the chosen scope actually uses are stored. */
function faqPayload(data: any) {
  const scope: FaqScope = data.scope;
  const usesLocation = scope === "LOCATION" || scope === "TAG_LOCATION";
  const usesTag = scope === "TAG" || scope === "TAG_LOCATION";
  return {
    scope,
    locationId: usesLocation ? Number(data.locationId) : null,
    tagId: usesTag ? Number(data.tagId) : null,
    path: scope === "PAGE" ? data.path.trim() : null,
    question: data.question.trim(),
    answer: data.answer.trim(),
    isActive: data.isActive ?? true,
    sortOrder: data.sortOrder ?? 0,
  };
}

export async function createFaq(data: any) {
  assertScopeTarget(data);
  return prisma.faq.create({ data: faqPayload(data) });
}

export async function updateFaq(id: number, data: any) {
  const existing = await prisma.faq.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("سوال یافت نشد");
  const merged = { ...existing, ...data };
  assertScopeTarget(merged);
  return prisma.faq.update({ where: { id }, data: faqPayload(merged) });
}

export async function deleteFaq(id: number) {
  return prisma.faq.delete({ where: { id } });
}

export async function reorderFaqs(ids: number[]) {
  await Promise.all(
    ids.map((id, i) =>
      prisma.faq.update({ where: { id }, data: { sortOrder: i + 1 } }),
    ),
  );
  return { ok: true };
}
