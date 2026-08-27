/**
 * The SMS that goes out when the other side writes.
 *
 * Odoo did this, so hosts and guests already expect it — dropping it in the
 * migration would read as the site having gone quiet, not as a feature having
 * been removed. What Odoo did not do is hold back, which is the part worth
 * getting right: a back-and-forth conversation must not become thirty text
 * messages.
 *
 * Four gates, cheapest first:
 *   1. muted        — the participant asked not to hear about this thread
 *   2. online       — they have the thread open; they are already reading it
 *   3. throttled    — one SMS per thread per participant per window
 *   4. no phone     — nothing to send to
 */

import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { isOnline, takeToken } from "@/lib/pubsub";
import { env } from "@/config/env";

/** Long enough that a live exchange sends one SMS, short enough to still be a nudge. */
const THROTTLE_SECONDS = 15 * 60;

const SITE = env.appUrl.replace(/\/$/, "");

export async function notifyNewMessage(
  conversationId: number,
  senderId: number | null,
  body: string
): Promise<void> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        publicId: true,
        type: true,
        participants: {
          where: {
            leftAt: null,
            isMuted: false,
            // Admins live in the panel. Texting them on every message in a
            // thread they stepped into once is noise, not a notification.
            role: { not: "ADMIN" },
            ...(senderId ? { userId: { not: senderId } } : {}),
          },
          select: {
            userId: true,
            role: true,
            notifiedAt: true,
            user: { select: { phone: true, name: true } },
          },
        },
      },
    });
    if (!conversation) return;

    const sender = senderId
      ? await prisma.user.findUnique({ where: { id: senderId }, select: { name: true } })
      : null;
    const who = sender?.name?.trim() || (conversation.type === "SUPPORT" ? "پشتیبانی" : "کاربر");

    const preview = body.replace(/\s+/g, " ").trim().slice(0, 60);
    const link = `${SITE}/chats?c=${conversation.publicId}`;
    const text = `${who} برایتان پیام فرستاد:\n${preview}\n${link}`;

    await Promise.all(
      conversation.participants.map(async (participant) => {
        const phone = participant.user.phone;
        if (!phone) return;

        if (await isOnline(participant.userId)) return;

        // The stored timestamp is the throttle that works with no Redis at
        // all; the token below is the atomic one, which is what stops two
        // instances handling two messages at once from both deciding they are
        // first. Both have to pass.
        const since = participant.notifiedAt ? Date.now() - participant.notifiedAt.getTime() : Infinity;
        if (since < THROTTLE_SECONDS * 1000) return;

        const fresh = await takeToken(
          `sms:${conversationId}:${participant.userId}`,
          THROTTLE_SECONDS
        );
        if (!fresh) return;

        await sendSms(phone, text);
        await prisma.conversationParticipant.updateMany({
          where: { conversationId, userId: participant.userId },
          data: { notifiedAt: new Date() },
        });
      })
    );
  } catch (error) {
    // This runs detached from the request that caused it. An unhandled
    // rejection here would take the process down over a text message.
    console.warn(`[chat] notification failed for conversation ${conversationId}:`, error);
  }
}
