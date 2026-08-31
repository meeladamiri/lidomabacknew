import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";

/**
 * نظرات — moderation from the panel.
 *
 * Reviews had no admin surface: 9,427 of them, published the moment a guest
 * submits one, with nothing the ops team could do about an abusive comment, a
 * duplicate, or one plainly written about a different stay.
 *
 * The only action offered is **hide**, never delete. A review is a guest's
 * statement about a stay, and both sides of a dispute need it to still exist —
 * the host who says it is unfair, and the guest who says theirs disappeared.
 * Hiding leaves the row, marked, with a reason and an author, exactly as
 * voiding leaves a payment.
 *
 * Hiding is not free: the listing's rating is denormalised onto the residence
 * row, so anything that changes which reviews are visible has to recompute it
 * in the same breath. A review hidden from readers but not from the score is
 * the bug this would otherwise ship with.
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
  hiddenAt: true,
  hiddenReason: true,
  hiddenById: true,
  createdAt: true,
  guest: { select: { id: true, name: true, phone: true, avatarUrl: true } },
  reservation: { select: { id: true, reference: true, startDate: true, endDate: true } },
  residence: { select: { id: true, name: true, reference: true } },
} as const;

/**
 * Recomputes a listing's stored rating from its **visible** reviews.
 *
 * Deliberately not imported from reservations.service: that one counts every
 * review, which is right when a guest submits one and wrong the moment
 * anything can be hidden. Both write the same two columns, so they must agree
 * on what counts — this is the definition that wins.
 */
export async function recomputeVisibleRating(residenceId: number) {
  const agg = await prisma.review.aggregate({
    where: { residenceId, hiddenAt: null },
    _avg: { averageRating: true },
    _count: true,
  });
  await prisma.residence.update({
    where: { id: residenceId },
    data: { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count },
  });
  return { averageRating: agg._avg.averageRating ?? 0, reviewsCount: agg._count };
}

export async function listForResidence(
  residenceId: number,
  options: { includeHidden?: boolean } = {}
) {
  const reviews = await prisma.review.findMany({
    where: {
      residenceId,
      ...(options.includeHidden ? {} : { hiddenAt: null }),
    },
    select: REVIEW_SELECT,
    orderBy: { createdAt: "desc" },
  });

  const visible = reviews.filter((r) => !r.hiddenAt);
  const avg = (pick: (r: (typeof visible)[number]) => number) =>
    visible.length
      ? Math.round((visible.reduce((s, r) => s + pick(r), 0) / visible.length) * 10) / 10
      : 0;

  return {
    reviews,
    summary: {
      total: reviews.length,
      visible: visible.length,
      hidden: reviews.length - visible.length,
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

export async function hideReview(reviewId: number, reason: string, actorId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, hiddenAt: true, guest: { select: { name: true } } },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");
  if (review.hiddenAt) throw AppError.badRequest("این نظر از قبل پنهان شده است");

  await prisma.review.update({
    where: { id: reviewId },
    data: { hiddenAt: new Date(), hiddenReason: reason, hiddenById: actorId },
  });

  const rating = await recomputeVisibleRating(review.residenceId);

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary: `نظر ${review.guest?.name ?? "مهمان"} پنهان شد`,
    details: { reviewId, reason, newRating: rating },
    actorId,
    source: "ADMIN",
  });

  return { ...rating, hidden: true };
}

export async function unhideReview(reviewId: number, actorId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, hiddenAt: true, guest: { select: { name: true } } },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");
  if (!review.hiddenAt) throw AppError.badRequest("این نظر پنهان نیست");

  await prisma.review.update({
    where: { id: reviewId },
    // The reason goes too. It described why the review was down, and it is
    // not down any more; keeping it would leave a sentence that contradicts
    // the row it sits on. The activity log keeps the history.
    data: { hiddenAt: null, hiddenReason: null, hiddenById: null },
  });

  const rating = await recomputeVisibleRating(review.residenceId);

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary: `نظر ${review.guest?.name ?? "مهمان"} دوباره نمایش داده شد`,
    details: { reviewId, newRating: rating },
    actorId,
    source: "ADMIN",
  });

  return { ...rating, hidden: false };
}

/**
 * Writes the host's public answer, from the panel.
 *
 * The host has their own endpoint for this. Support ends up writing these too
 * — a host asks for help replying, or a reply needs correcting — and the
 * alternative has been editing the row by hand. The answer is published as
 * the host's, because that is where it appears; the log records that it was
 * an admin who wrote it, because that is the part nobody could see.
 */
export async function answerReview(reviewId: number, answer: string, actorId: number) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, residenceId: true, hostAnswer: true },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  const updated = await prisma.review.update({
    where: { id: reviewId },
    data: { hostAnswer: answer },
    select: REVIEW_SELECT,
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: review.residenceId,
    summary: review.hostAnswer
      ? "پاسخ میزبان به یک نظر ویرایش شد"
      : "پاسخ میزبان به یک نظر ثبت شد",
    details: { reviewId, before: review.hostAnswer, after: answer },
    actorId,
    source: "ADMIN",
  });

  return updated;
}
