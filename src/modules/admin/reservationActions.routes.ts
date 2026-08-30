import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { env } from "@/config/env";
import * as activity from "@/modules/activity/activity.service";
import { record as recordNotification } from "@/modules/notifications/notifications.service";

/**
 * The action buttons on a reservation — Odoo's, rebuilt.
 *
 * Odoo had these as one server action each: «ارسال اطلاعات میزبان به مسافر»,
 * «ارسال اطلاعات مسافر به میزبان», «ارسال لینک اقامتگاه», «ارسال وچر به
 * میزبان», «ارسال شماره کارت», and `send review sms`. They are one endpoint
 * with a kind here, because they differ only in who receives what text, and
 * six near-identical handlers is six places to fix the next time the sender
 * changes.
 *
 * Every one writes a MESSAGE_SENT line to the activity log. That is the point
 * of the button as much as the message is: the question support actually asks
 * later is "did anyone send them the address?", and until now nothing could
 * answer it.
 *
 * ⚠️ SMS is still a stub (`lib/sms.ts`), so these deliver as in-app
 * notifications today. The recipient, the text and the log entry are all real;
 * only the transport is pending, and when it arrives it goes in one place.
 */
const router = Router();

type ActionKind =
  | "HOST_INFO_TO_GUEST"
  | "GUEST_INFO_TO_HOST"
  | "RESIDENCE_LINK_TO_GUEST"
  | "VOUCHER_TO_HOST"
  | "CARD_NUMBER_TO_GUEST"
  | "REVIEW_LINK_TO_GUEST";

const ACTION_LABEL: Record<ActionKind, string> = {
  HOST_INFO_TO_GUEST: "ارسال اطلاعات میزبان به مهمان",
  GUEST_INFO_TO_HOST: "ارسال اطلاعات مهمان به میزبان",
  RESIDENCE_LINK_TO_GUEST: "ارسال لینک اقامتگاه به مهمان",
  VOUCHER_TO_HOST: "ارسال وچر به میزبان",
  CARD_NUMBER_TO_GUEST: "ارسال شماره کارت به مهمان",
  REVIEW_LINK_TO_GUEST: "ارسال لینک نظرسنجی به مهمان",
};

const RESERVATION_FOR_ACTIONS = {
  id: true,
  reference: true,
  startDate: true,
  endDate: true,
  daysCount: true,
  guestsCount: true,
  totalAmount: true,
  remainingAmount: true,
  guestId: true,
  hostId: true,
  guestNameOverride: true,
  guestPhoneOverride: true,
  guest: { select: { id: true, name: true, phone: true } },
  host: { select: { id: true, name: true, phone: true, bankAccount: true } },
  residence: {
    select: { id: true, name: true, reference: true, address: true, latitude: true, longitude: true },
  },
} as const;

const faDate = (d: Date) =>
  new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(d);
const fa = (n: number) => n.toLocaleString("fa-IR");

/** Builds the message for one action: who gets it, what it says, where it points. */
function compose(
  kind: ActionKind,
  r: {
    reference: string;
    startDate: Date;
    endDate: Date;
    daysCount: number;
    guestsCount: number;
    totalAmount: number;
    remainingAmount: number;
    guestId: number;
    hostId: number;
    guestNameOverride: string | null;
    guestPhoneOverride: string | null;
    guest: { name: string | null; phone: string };
    host: { name: string | null; phone: string; bankAccount: { cardNumber: string | null; cardOwnerName: string | null } | null };
    residence: { id: number; name: string; reference: string | null; address: string | null };
  }
): { userId: number; title: string; body: string; linkUrl: string } {
  const stay = `${faDate(r.startDate)} تا ${faDate(r.endDate)}`;
  const guestName = r.guestNameOverride || r.guest.name || "مهمان";
  const guestPhone = r.guestPhoneOverride || r.guest.phone;
  // Migrated listings are addressable only by their Odoo id (see lib/publicId).
  const residenceUrl = `/residences/${
    r.residence.reference?.startsWith("ODOO-") ? r.residence.reference.slice(5) : r.residence.id
  }`;

  switch (kind) {
    case "HOST_INFO_TO_GUEST":
      return {
        userId: r.guestId,
        title: "اطلاعات میزبان",
        body: `میزبان ${r.residence.name}: ${r.host.name ?? "—"} — ${r.host.phone}${
          r.residence.address ? `\nنشانی: ${r.residence.address}` : ""
        }`,
        linkUrl: `/profile/my-trips?reservation=${r.reference}`,
      };

    case "GUEST_INFO_TO_HOST":
      return {
        userId: r.hostId,
        title: "اطلاعات مهمان",
        body: `مهمان رزرو ${r.reference}: ${guestName} — ${guestPhone}\n${fa(
          r.guestsCount
        )} نفر · ${stay}`,
        linkUrl: `/profile/reserves?reservation=${r.reference}`,
      };

    case "RESIDENCE_LINK_TO_GUEST":
      return {
        userId: r.guestId,
        title: "لینک اقامتگاه",
        body: `${r.residence.name}\n${env.appUrl}${residenceUrl}`,
        linkUrl: residenceUrl,
      };

    case "VOUCHER_TO_HOST":
      return {
        userId: r.hostId,
        title: `وچر رزرو ${r.reference}`,
        body: `${r.residence.name}\n${guestName} — ${guestPhone}\n${stay} (${fa(
          r.daysCount
        )} شب، ${fa(r.guestsCount)} نفر)\nمبلغ کل: ${fa(r.totalAmount)} تومان`,
        linkUrl: `/profile/reserves?reservation=${r.reference}`,
      };

    case "CARD_NUMBER_TO_GUEST": {
      const card = r.host.bankAccount?.cardNumber;
      if (!card) {
        // Refused rather than sent empty: a message telling a guest to transfer
        // money to nothing is worse than no message.
        throw AppError.badRequest("شماره کارت میزبان ثبت نشده است");
      }
      return {
        userId: r.guestId,
        title: "اطلاعات پرداخت",
        body: `شماره کارت: ${card}\nبه نام: ${r.host.bankAccount?.cardOwnerName ?? "—"}\nمبلغ قابل پرداخت: ${fa(
          r.remainingAmount || r.totalAmount
        )} تومان\nرزرو ${r.reference}`,
        linkUrl: `/profile/my-trips?reservation=${r.reference}`,
      };
    }

    case "REVIEW_LINK_TO_GUEST":
      return {
        userId: r.guestId,
        title: "نظر شما درباره اقامت",
        body: `اقامتتان در ${r.residence.name} تمام شد. ثبت نظر به مهمان‌های بعدی کمک می‌کند.`,
        linkUrl: `/submit-review?reservation=${r.reference}`,
      };
  }
}

router.post(
  "/:id/actions",
  validate(
    z.object({
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({
        kind: z.enum([
          "HOST_INFO_TO_GUEST",
          "GUEST_INFO_TO_HOST",
          "RESIDENCE_LINK_TO_GUEST",
          "VOUCHER_TO_HOST",
          "CARD_NUMBER_TO_GUEST",
          "REVIEW_LINK_TO_GUEST",
        ]),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { kind } = req.body as { kind: ActionKind };

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      select: RESERVATION_FOR_ACTIONS,
    });
    if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

    const message = compose(kind, reservation);

    await recordNotification({
      userId: message.userId,
      kind: "MESSAGE_RECEIVED",
      title: message.title,
      body: message.body,
      linkUrl: message.linkUrl,
      // Deliberately not keyed to the reservation: the idempotency index would
      // then let this be sent only once, and "send it again, they lost it" is
      // the most common reason the button gets pressed.
      entityType: null,
      entityId: null,
    });

    await activity.record({
      kind: "MESSAGE_SENT",
      reservationId: reservation.id,
      userId: message.userId,
      summary: `${ACTION_LABEL[kind]} — ${message.title}`,
      details: { action: kind, to: message.userId, body: message.body } as never,
      actorId: req.user!.sub,
      source: "ACTION",
    });

    return ok(res, { sent: true, label: ACTION_LABEL[kind], to: message.userId });
  })
);

/** Everything the printable invoice needs, in one call. */
router.get(
  "/:id/invoice",
  validate(z.object({ params: z.object({ id: z.coerce.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };

    const r = await prisma.reservation.findUnique({
      where: { id },
      select: {
        ...RESERVATION_FOR_ACTIONS,
        state: true,
        paidAmount: true,
        websiteShare: true,
        vatAmount: true,
        guestCommission: true,
        hostShare: true,
        settledAmount: true,
        clearRemainder: true,
        commissionPercent: true,
        createdAt: true,
      },
    });
    if (!r) throw AppError.notFound("رزرو پیدا نشد");

    return ok(res, r);
  })
);

export default router;
