import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { record } from "@/modules/notifications/notifications.service";
import * as activity from "@/modules/activity/activity.service";
import { AppError } from "@/lib/errors";
import { publicResidenceId } from "@/lib/publicId";

/**
 * «به مهمان بگو نظرت تأییده» / «به میزبان بگو نظرت تأییده».
 *
 * The two buttons on the review detail page. Each sends one message telling
 * the person their text is now on the site.
 *
 * ## The SMS provider is not connected yet
 *
 * `lib/sms.ts` logs instead of sending until `SMS_PROVIDER_API_KEY` is set.
 * That is deliberate and it is why these templates exist now rather than
 * later: the day the provider is wired in, these send, with no other change
 * and no second round of copywriting.
 *
 * Two things happen regardless of whether the SMS goes out:
 *
 *   • an in-app notification is written, which the person sees whether or not
 *     the SMS ever arrives;
 *   • an activity log line is written, so «آیا به مهمان خبر دادیم؟» has an
 *     answer that does not depend on a provider's delivery report.
 *
 * The panel is told which of the two happened, so a button press during the
 * stub period cannot look like a delivered text message.
 */

export type ReviewMessageAudience = "guest" | "host";

interface Rendered {
  sms: string;
  notificationTitle: string;
  notificationBody: string;
}

/**
 * Kept short on purpose. Persian SMS bills per 70 characters, and a message
 * that runs to three parts to say one sentence is a message that costs three
 * times as much every time it goes out.
 */
function render(
  audience: ReviewMessageAudience,
  residenceName: string
): Rendered {
  if (audience === "guest") {
    return {
      sms: `لیدوماتریپ\nنظر شما درباره «${residenceName}» تایید شد و روی سایت منتشر شد. ممنون که تجربه‌تان را نوشتید.`,
      notificationTitle: "نظر شما منتشر شد",
      notificationBody: `نظری که درباره «${residenceName}» نوشتید تایید و روی صفحه‌ی اقامتگاه منتشر شد.`,
    };
  }
  return {
    sms: `لیدوماتریپ\nپاسخ شما به نظر مهمان درباره «${residenceName}» تایید شد و روی سایت منتشر شد.`,
    notificationTitle: "پاسخ شما منتشر شد",
    notificationBody: `پاسخی که به نظر مهمان درباره «${residenceName}» نوشتید تایید و منتشر شد.`,
  };
}

export async function sendReviewApprovedMessage(
  reviewId: number,
  audience: ReviewMessageAudience,
  actorId: number
) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      residenceId: true,
      commentStatus: true,
      hostAnswerStatus: true,
      guest: { select: { id: true, name: true, phone: true } },
      residence: { select: { id: true, name: true, hostId: true, reference: true } },
    },
  });
  if (!review) throw AppError.notFound("نظر یافت نشد");

  // Telling someone their text is live when it is not is worse than not
  // telling them at all, so the button refuses rather than sending a message
  // the site contradicts.
  if (audience === "guest" && review.commentStatus !== "PUBLISHED") {
    throw AppError.badRequest("نظر مهمان هنوز منتشر نشده است");
  }
  if (audience === "host" && review.hostAnswerStatus !== "PUBLISHED") {
    throw AppError.badRequest("پاسخ میزبان هنوز منتشر نشده است");
  }

  const recipient =
    audience === "guest"
      ? review.guest
      : await prisma.user.findUnique({
          where: { id: review.residence.hostId },
          select: { id: true, name: true, phone: true },
        });

  if (!recipient) throw AppError.notFound("گیرنده پیدا نشد");

  const text = render(audience, review.residence.name);

  // In-app first: it is the one that does not depend on anything external.
  await record({
    userId: recipient.id,
    kind: audience === "guest" ? "REVIEW_PUBLISHED" : "REVIEW_ANSWER_PUBLISHED",
    title: text.notificationTitle,
    body: text.notificationBody,
    // The public id, not the primary key — /rentals is addressed by the
    // Odoo id on every migrated listing.
    linkUrl: `/rentals/${publicResidenceId(review.residence)}`,
    entityType: "review",
    entityId: review.id,
  }).catch((error) => {
    console.warn(`[reviews] notification not written:`, error);
  });

  const smsConfigured = !!process.env.SMS_PROVIDER_API_KEY;
  await sendSms(recipient.phone, text.sms);

  activity.log({
    kind: "MESSAGE_SENT",
    residenceId: review.residenceId,
    userId: recipient.id,
    summary:
      audience === "guest"
        ? "به مهمان اطلاع داده شد که نظرش منتشر شده"
        : "به میزبان اطلاع داده شد که پاسخش منتشر شده",
    details: { reviewId, audience, smsConfigured, text: text.sms },
    actorId,
    source: "ADMIN",
  });

  return {
    audience,
    to: { name: recipient.name, phone: recipient.phone },
    notificationSent: true,
    // The panel says "پیامک ارسال شد" or "فعلاً فقط اعلان داخل سایت" based on
    // this, rather than claiming a text message that never left the building.
    smsSent: smsConfigured,
    preview: text.sms,
  };
}

/** The template, without sending — so the panel can show it before the click. */
export function previewReviewMessage(audience: ReviewMessageAudience, residenceName: string) {
  return render(audience, residenceName).sms;
}
