import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import { parsePagination } from "@/utils/pagination";
import type { Prisma, ReviewModerationStatus } from "@prisma/client";
import {
  deriveReviewStatus,
  REVIEW_STATUS_RANK,
  REVIEW_STATUS_LABEL,
  type DerivedReviewStatus,
} from "./reviewStatus";

/**
 * نظرات — moderation from the panel.
 *
 * A review is **two things to moderate**: what the guest wrote and what the
 * host wrote back. Each is approved on its own, because they arrive days apart
 * and because the most useful state in the queue — "the review is already live
 * and the host has just replied" — cannot exist if there is one flag per row.
 *
 * Nothing is ever deleted. A rejected review keeps its row, its reason and its
 * author: a host disputing one and a guest asking why theirs vanished both
 * need it to still exist.
 *
 * ## The rating is denormalised
 *
 * `residences.averageRating` and `reviewsCount` live on the residence row, so
 * **anything that changes which comments are published must recompute them in
 * the same breath**. A review taken off the site but still dragging the score
 * is the bug this module exists in order not to have.
 */

const REVIEW_SELECT = {
  id: true,
  residenceId: true,
  reservationId: true,
  cleaning: true,
  location: true,
  quality: true,
  integrity: true,
  greeting: true,
  delivery: true,
  averageRating: true,
  comment: true,
  hostAnswer: true,
  commentStatus: true,
  hostAnswerStatus: true,
  hostAnsweredAt: true,
  moderatedAt: true,
  moderationNote: true,
  moderatedById: true,
  hostAnswerModeratedAt: true,
  createdAt: true,
  guest: { select: { id: true, name: true, phone: true, avatarUrl: true } },
  reservation: {
    select: { id: true, reference: true, startDate: true, endDate: true },
  },
  residence: {
    select: {
      id: true,
      name: true,
      reference: true,
      host: { select: { id: true, name: true, phone: true, avatarUrl: true } },
    },
  },
} as const;

type ReviewRow = Prisma.ReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

/** Attaches the single badge the panel shows, derived from the two statuses. */
function withStatus(review: ReviewRow) {
  const status = deriveReviewStatus(review);
  return { ...review, status, statusLabel: REVIEW_STATUS_LABEL[status] };
}

/**
 * Recomputes a listing's stored rating from its **published** comments.
 *
 * Deliberately not the one in reservations.service, which counts every review
 * — right when a guest submits one, wrong the moment anything can be withheld.
 * Both write the same two columns, so they must agree on what counts, and this
 * is the definition that wins.
 */
export async function recomputeVisibleRating(residenceId: number) {
  const agg = await prisma.review.aggregate({
    where: { residenceId, commentStatus: "PUBLISHED" },
    _avg: { averageRating: true },
    _count: true,
  });
  await prisma.residence.update({
    where: { id: residenceId },
    data: { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count },
  });
  return { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count };
}

// ---------------------------------------------------------------- listing

export type ReviewTab = "all" | "pending" | "published" | "rejected" | "low";

const TAB_WHERE: Record<ReviewTab, Prisma.ReviewWhereInput> = {
  all: {},
  // Anything a person is waiting on: an unapproved comment, or an unapproved
  // reply sitting under a comment that is already live.
  pending: { OR: [{ commentStatus: "PENDING" }, { hostAnswerStatus: "PENDING" }] },
  published: { commentStatus: "PUBLISHED" },
  rejected: { commentStatus: "REJECTED" },
  low: { commentStatus: "PUBLISHED", averageRating: { lt: 3 } },
};

/**
 * Above this many matching rows, "action" order falls back to newest-first.
 *
 * The rank is derived from two columns and cannot be an ORDER BY, so sorting
 * by it means loading the filtered set. That is fine for a moderation queue
 * and not fine for "all 9,427 reviews", so there is a cap and the response
 * says which order it actually used.
 */
const ACTION_SORT_CAP = 2000;

export async function list(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  tab?: ReviewTab;
  residenceId?: number;
  hostId?: number;
  sort?: "action" | "newest" | "oldest" | "rating_asc" | "rating_desc";
}) {
  const { page, pageSize, skip, take } = parsePagination(params);

  const where: Prisma.ReviewWhereInput = {
    ...(TAB_WHERE[params.tab ?? "all"] ?? {}),
    ...(params.residenceId ? { residenceId: params.residenceId } : {}),
    ...(params.hostId ? { residence: { hostId: params.hostId } } : {}),
    ...(params.q
      ? {
          OR: [
            { comment: { contains: params.q, mode: "insensitive" } },
            { hostAnswer: { contains: params.q, mode: "insensitive" } },
            { residence: { name: { contains: params.q, mode: "insensitive" } } },
            { residence: { reference: { contains: params.q, mode: "insensitive" } } },
            { guest: { name: { contains: params.q, mode: "insensitive" } } },
            { guest: { phone: { contains: params.q } } },
          ],
        }
      : {}),
  };

  const sort = params.sort ?? "action";

  if (sort === "action") {
    const total = await prisma.review.count({ where });

    if (total <= ACTION_SORT_CAP) {
      const all = await prisma.review.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: REVIEW_SELECT,
      });
      const ranked = all
        .map(withStatus)
        .sort((a, b) => REVIEW_STATUS_RANK[a.status] - REVIEW_STATUS_RANK[b.status]);
      return {
        total,
        page,
        pageSize,
        items: ranked.slice(skip, skip + take),
        sortedBy: "action" as const,
      };
    }

    const items = await prisma.review.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: REVIEW_SELECT,
    });
    return {
      total,
      page,
      pageSize,
      items: items.map(withStatus),
      // Said out loud, so the panel can tell the user the order it asked for
      // is not the order it got.
      sortedBy: "newest" as const,
    };
  }

  const orderBy: Prisma.ReviewOrderByWithRelationInput =
    sort === "oldest"
      ? { createdAt: "asc" }
      : sort === "rating_asc"
        ? { averageRating: "asc" }
        : sort === "rating_desc"
          ? { averageRating: "desc" }
          : { createdAt: "desc" };

  const [total, items] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({ where, skip, take, orderBy, select: REVIEW_SELECT }),
  ]);

  return { total, page, pageSize, items: items.map(withStatus), sortedBy: sort };
}

/**
 * The counts behind the tabs.
 *
 * A separate call rather than five more aggregates on every page: the numbers
 * do not change as you page through, and recomputing them each time makes
 * paging cost five extra counts over the whole table.
 */
export async function tabCounts() {
  const [all, pending, published, rejected, low] = await Promise.all([
    prisma.review.count(),
    prisma.review.count({ where: TAB_WHERE.pending }),
    prisma.review.count({ where: TAB_WHERE.published }),
    prisma.review.count({ where: TAB_WHERE.rejected }),
    prisma.review.count({ where: TAB_WHERE.low }),
  ]);
  return { all, pending, published, rejected, low };
}

export async function getOne(reviewId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: REVIEW_SELECT,
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");
  return withStatus(review);
}

export async function listForResidence(
  residenceId: number,
  options: { includeHidden?: boolean } = {}
) {
  const reviews = await prisma.review.findMany({
    where: {
      residenceId,
      ...(options.includeHidden ? {} : { commentStatus: "PUBLISHED" }),
    },
    select: REVIEW_SELECT,
    orderBy: { createdAt: "desc" },
  });

  const rows = reviews.map(withStatus);
  const visible = rows.filter((r) => r.commentStatus === "PUBLISHED");
  const avg = (pick: (r: (typeof visible)[number]) => number) =>
    visible.length
      ? Math.round((visible.reduce((s, r) => s + pick(r), 0) / visible.length) * 10) / 10
      : 0;

  return {
    reviews: rows,
    summary: {
      total: rows.length,
      visible: visible.length,
      hidden: rows.filter((r) => r.commentStatus === "REJECTED").length,
      pending: rows.filter((r) => r.commentStatus === "PENDING").length,
      unanswered: visible.filter((r) => !r.hostAnswer).length,
      average: avg((r) => r.averageRating),
      cleaning: avg((r) => r.cleaning),
      location: avg((r) => r.location),
      quality: avg((r) => r.quality),
      integrity: avg((r) => r.integrity),
      greeting: avg((r) => r.greeting),
      delivery: avg((r) => r.delivery),
    },
  };
}

// ------------------------------------------------------------- moderation

/**
 * Publishes or rejects the guest's comment.
 *
 * Always recomputes the listing's rating, including on a no-op re-publish:
 * the recompute is cheap, and the one time it gets skipped is the one time the
 * stored average was already wrong for some other reason.
 */
export async function setCommentStatus(
  reviewId: number,
  status: ReviewModerationStatus,
  options: { note?: string | null; actorId: number }
) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      residenceId: true,
      commentStatus: true,
      guest: { select: { name: true } },
    },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  // Rejecting is the one that needs a reason: months later, "why is this
  // review not on the site" is the only question anyone asks about it.
  if (status === "REJECTED" && !options.note?.trim()) {
    throw AppError.badRequest("برای رد کردن نظر، ثبت دلیل الزامی است");
  }

  await prisma.review.update({
    where: { id: reviewId },
    data: {
      commentStatus: status,
      moderatedAt: new Date(),
      moderationNote: status === "REJECTED" ? options.note!.trim() : null,
      moderatedById: options.actorId,
    },
  });

  const rating = await recomputeVisibleRating(review.residenceId);

  activity.log({
    kind: "STATE_CHANGE",
    residenceId: review.residenceId,
    summary: `نظر ${review.guest?.name ?? "مهمان"} ${
      status === "PUBLISHED"
        ? "تایید و منتشر شد"
        : status === "REJECTED"
          ? "رد شد"
          : "به حالت بررسی برگشت"
    }`,
    details: {
      reviewId,
      from: review.commentStatus,
      to: status,
      note: options.note ?? null,
      rating,
    },
    actorId: options.actorId,
    source: "ADMIN",
  });

  return getOne(reviewId);
}

/** Publishes or rejects the host's reply. Never touches the rating. */
export async function setHostAnswerStatus(
  reviewId: number,
  status: ReviewModerationStatus,
  options: { note?: string | null; actorId: number }
) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, hostAnswer: true, hostAnswerStatus: true },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");
  if (!review.hostAnswer) throw AppError.badRequest("میزبان هنوز پاسخی ننوشته است");

  await prisma.review.update({
    where: { id: reviewId },
    data: { hostAnswerStatus: status, hostAnswerModeratedAt: new Date() },
  });

  activity.log({
    kind: "STATE_CHANGE",
    residenceId: review.residenceId,
    summary: `پاسخ میزبان ${
      status === "PUBLISHED"
        ? "تایید و منتشر شد"
        : status === "REJECTED"
          ? "رد شد"
          : "به حالت بررسی برگشت"
    }`,
    details: { reviewId, from: review.hostAnswerStatus, to: status, note: options.note ?? null },
    actorId: options.actorId,
    source: "ADMIN",
  });

  return getOne(reviewId);
}

// ----------------------------------------------------------------- editing

/**
 * Edits the guest's comment text.
 *
 * The panel can do this because in practice it has to: a phone number left in
 * a review, a name, an insult inside an otherwise fair complaint. The only
 * alternative on offer until now was rejecting the whole thing, which throws
 * away a real opinion to fix one line.
 *
 * **The original goes in the activity log.** Editing what a guest said and
 * leaving no record of what they actually said is the thing that would make
 * this feature dangerous, and it is the one part that cannot be skipped.
 */
export async function editComment(reviewId: number, comment: string, actorId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, comment: true },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  await prisma.review.update({ where: { id: reviewId }, data: { comment } });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary: "متن نظر مهمان توسط کارشناس ویرایش شد",
    details: { reviewId, before: review.comment, after: comment },
    actorId,
    source: "ADMIN",
  });

  return getOne(reviewId);
}

/** The six things a guest scores, and the labels the log writes them under. */
export const SCORE_FIELDS = {
  cleaning: "نظافت اقامتگاه",
  location: "موقعیت مکانی",
  quality: "کیفیت نسبت به نرخ",
  integrity: "صحت اطلاعات",
  greeting: "برخورد میزبان",
  delivery: "نحوه تحویل",
} as const;

export type ScoreField = keyof typeof SCORE_FIELDS;

/**
 * Edits the guest's scores.
 *
 * Support corrects these when a guest plainly mis-tapped — five stars in the
 * text and one on the slider — or when a score was left against the wrong
 * listing. Rare, but the only alternative on offer was rejecting the review.
 *
 * **Two derived values have to move with it**, and both are the kind that
 * fails silently:
 *
 *   1. `Review.averageRating` is stored, not computed on read. It is the mean
 *      of the six, and the definition is copied from where a guest's review is
 *      created — if these two ever disagree, an edited review sorts and filters
 *      differently from an untouched one.
 *   2. `Residence.averageRating` and `reviewsCount` are denormalised from
 *      every published review, so changing one score changes the listing's
 *      score on every search page it appears on.
 *
 * The log records each score that moved, by name, with both values.
 */
export async function editScores(
  reviewId: number,
  scores: Partial<Record<ScoreField, number>>,
  actorId: number
) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      residenceId: true,
      cleaning: true,
      location: true,
      quality: true,
      integrity: true,
      greeting: true,
      delivery: true,
      averageRating: true,
    },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  const next = {
    cleaning: scores.cleaning ?? review.cleaning,
    location: scores.location ?? review.location,
    quality: scores.quality ?? review.quality,
    integrity: scores.integrity ?? review.integrity,
    greeting: scores.greeting ?? review.greeting,
    delivery: scores.delivery ?? review.delivery,
  };

  const changed = (Object.keys(SCORE_FIELDS) as ScoreField[])
    .filter((k) => next[k] !== review[k])
    .map((k) => ({ field: k, label: SCORE_FIELDS[k], before: review[k], after: next[k] }));

  if (changed.length === 0) return getOne(reviewId);

  // The same mean as `submitReview` — six values, unweighted. Copied rather
  // than imported because that one runs inside the booking flow; if either
  // definition changes, this comment is the reason to change both.
  const values = Object.values(next);
  const averageRating = values.reduce((a, b) => a + b, 0) / values.length;

  await prisma.review.update({
    where: { id: reviewId },
    data: { ...next, averageRating },
  });

  const rating = await recomputeVisibleRating(review.residenceId);

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary:
      "امتیازهای نظر توسط کارشناس ویرایش شد: " +
      changed.map((c) => `${c.label} ${c.before}→${c.after}`).join(" · "),
    details: {
      reviewId,
      changed,
      averageBefore: review.averageRating,
      averageAfter: averageRating,
      residenceRating: rating,
    },
    actorId,
    source: "ADMIN",
  });

  return getOne(reviewId);
}

/**
 * Writes or edits the host's public reply, from the panel.
 *
 * Support ends up doing this — a host asks for help replying, or a published
 * reply needs a typo fixed. It appears as the host's, because that is where it
 * appears; the log records that an admin wrote it, because that is the part
 * nobody else can see.
 *
 * A reply written here starts PENDING like any other. One that already has a
 * status keeps it: correcting a typo should not take a published reply off the
 * site and put it back in the queue.
 */
export async function editHostAnswer(reviewId: number, answer: string, actorId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, hostAnswer: true, hostAnswerStatus: true },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  await prisma.review.update({
    where: { id: reviewId },
    data: {
      hostAnswer: answer,
      hostAnswerStatus: review.hostAnswerStatus ?? "PENDING",
      hostAnsweredAt: review.hostAnswer ? undefined : new Date(),
    },
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary: review.hostAnswer
      ? "پاسخ میزبان توسط کارشناس ویرایش شد"
      : "پاسخ میزبان توسط کارشناس ثبت شد",
    details: { reviewId, before: review.hostAnswer, after: answer },
    actorId,
    source: "ADMIN",
  });

  return getOne(reviewId);
}

export type { DerivedReviewStatus };
