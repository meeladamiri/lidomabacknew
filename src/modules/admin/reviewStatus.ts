import type { ReviewModerationStatus } from "@prisma/client";

/**
 * The one status a review shows in the panel, derived from its two.
 *
 * A review carries a guest comment and, sometimes, a host reply — each
 * approved on its own. The list still needs a single badge, so the two
 * collapse into one here, in one place, rather than in every component that
 * renders a row.
 *
 * The order below is also the *work* order. A reviewer opening this page is
 * asking "what needs me", and the answer is: things somebody is waiting on,
 * newest first. Everything settled sinks.
 */
export type DerivedReviewStatus =
  | "AWAITING_HOST_ANSWER_APPROVAL"
  | "AWAITING_GUEST_COMMENT_APPROVAL"
  | "AWAITING_BOTH"
  | "PUBLISHED"
  | "REJECTED";

export const REVIEW_STATUS_LABEL: Record<DerivedReviewStatus, string> = {
  AWAITING_HOST_ANSWER_APPROVAL: "در انتظار تایید نظر میزبان",
  AWAITING_GUEST_COMMENT_APPROVAL: "در انتظار تایید نظر مهمان",
  AWAITING_BOTH: "در انتظار تایید",
  PUBLISHED: "منتشر شده",
  REJECTED: "رد شده",
};

/**
 * Lower sorts first.
 *
 * `AWAITING_HOST_ANSWER_APPROVAL` is deliberately ahead of everything: the
 * guest's review is already on the site and the host has answered it, so the
 * reply is the only thing standing between the listing and a finished
 * conversation — and until it is approved the page shows a complaint with no
 * response under it.
 */
export const REVIEW_STATUS_RANK: Record<DerivedReviewStatus, number> = {
  AWAITING_HOST_ANSWER_APPROVAL: 0,
  AWAITING_BOTH: 1,
  AWAITING_GUEST_COMMENT_APPROVAL: 2,
  PUBLISHED: 3,
  REJECTED: 4,
};

export interface ReviewStatusInput {
  commentStatus: ReviewModerationStatus;
  hostAnswerStatus: ReviewModerationStatus | null;
  hostAnswer: string | null;
}

export function deriveReviewStatus(review: ReviewStatusInput): DerivedReviewStatus {
  const { commentStatus, hostAnswerStatus, hostAnswer } = review;
  const hasAnswer = !!hostAnswer && hostAnswerStatus !== null;

  // A rejected comment settles the whole row: there is nothing on the site for
  // a reply to sit under, so the reply's own state stops mattering.
  if (commentStatus === "REJECTED") return "REJECTED";

  if (commentStatus === "PENDING") {
    return hasAnswer && hostAnswerStatus === "PENDING"
      ? "AWAITING_BOTH"
      : "AWAITING_GUEST_COMMENT_APPROVAL";
  }

  // commentStatus === "PUBLISHED"
  if (hasAnswer && hostAnswerStatus === "PENDING") return "AWAITING_HOST_ANSWER_APPROVAL";

  // A rejected reply under a published review is not a third badge: the guest
  // sees exactly what they would see if the host had never answered.
  return "PUBLISHED";
}
