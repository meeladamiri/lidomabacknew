/**
 * Conversations: host <-> guest threads attached to a reservation, and
 * user <-> support threads.
 *
 * Replaces the Odoo endpoints the front still calls (get_order_messages,
 * get_messages, add_message, support_chats/*), all of which are dead. The
 * behaviour those had — including an SMS when the other side writes — is kept;
 * see notify.ts.
 */

import { randomBytes } from "node:crypto";
import { Prisma, type ConversationType, type MessageType, type ParticipantRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { looksOffPlatform, normalizeBody, previewOf } from "@/lib/chatSafety";
import { publish } from "@/lib/pubsub";
import { publicResidenceId } from "@/lib/publicId";
import { notifyNewMessage } from "./notify";

const PAGE_SIZE = 30;

/** URL-safe, unguessable, and short enough to read out loud if it ever needs to be. */
function newPublicId(): string {
  return randomBytes(9).toString("base64url");
}

// ---------------------------------------------------------------- shapes ---

const PARTICIPANT_SELECT = {
  id: true,
  role: true,
  unreadCount: true,
  lastReadAt: true,
  lastReadMessageId: true,
  isMuted: true,
  user: { select: { id: true, name: true, avatarUrl: true, isHost: true } },
} satisfies Prisma.ConversationParticipantSelect;

const MESSAGE_SELECT = {
  id: true,
  type: true,
  body: true,
  meta: true,
  senderId: true,
  senderRole: true,
  attachmentUrl: true,
  attachmentName: true,
  attachmentSize: true,
  clientNonce: true,
  flagged: true,
  deletedAt: true,
  createdAt: true,
  sender: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.MessageSelect;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/**
 * A deleted message keeps its place in the thread.
 *
 * Removing the row would renumber nothing but would leave the other side
 * staring at a gap in a conversation they remember differently. The tombstone
 * is honest and costs one row.
 */
function toMessage(row: MessageRow) {
  const deleted = !!row.deletedAt;
  return {
    id: row.id,
    type: row.type,
    body: deleted ? "" : row.body,
    meta: deleted ? null : row.meta,
    deleted,
    sender_id: row.senderId,
    sender_role: row.senderRole,
    sender_name: deleted ? null : row.sender?.name ?? null,
    sender_avatar: deleted ? null : row.sender?.avatarUrl ?? null,
    attachment_url: deleted ? null : row.attachmentUrl,
    attachment_name: deleted ? null : row.attachmentName,
    attachment_size: deleted ? null : row.attachmentSize,
    client_nonce: row.clientNonce,
    created_at: row.createdAt,
  };
}

// ----------------------------------------------------------- membership ---

/**
 * Loads a conversation the caller is allowed to see, or throws.
 *
 * Admins reach support threads through their role rather than membership —
 * making every admin a participant of every support thread would put every
 * ticket in every admin's own conversation list.
 */
export async function requireAccess(publicId: string, userId: number, isAdmin: boolean) {
  const conversation = await prisma.conversation.findUnique({
    where: { publicId },
    include: {
      participants: { select: PARTICIPANT_SELECT },
      booking: {
        select: {
          id: true,
          reference: true,
          startDate: true,
          endDate: true,
          guestsCount: true,
          state: true,
          totalAmount: true,
        },
      },
      residence: { select: { id: true, name: true, reference: true, images: { select: { url: true }, orderBy: [{ isMain: "desc" }, { sortOrder: "asc" }], take: 1 } } },
    },
  });

  if (!conversation) throw AppError.notFound("گفتگو پیدا نشد");

  const me = conversation.participants.find((p) => p.user.id === userId) ?? null;
  const adminPool = isAdmin && conversation.type === "SUPPORT";
  if (!me && !isAdmin && !adminPool) throw AppError.forbidden("به این گفتگو دسترسی ندارید");

  return { conversation, me };
}

// ------------------------------------------------------------- creation ---

/**
 * The conversation for a reservation, created if it is not there yet.
 *
 * Idempotent through the unique index on booking_id rather than a read
 * followed by a write: two callers — the booking endpoint and an admin
 * opening the thread — can arrive at once, and both would pass a read check.
 * The unique violation is the answer, not an error.
 */
export async function ensureBookingConversation(reservationId: number) {
  const existing = await prisma.conversation.findUnique({ where: { bookingId: reservationId } });
  if (existing) return existing;

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      reference: true,
      guestId: true,
      hostId: true,
      residenceId: true,
      startDate: true,
      endDate: true,
      guestsCount: true,
      extraGuestsCount: true,
      residence: { select: { id: true, name: true, reference: true } },
    },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  try {
    const conversation = await prisma.conversation.create({
      data: {
        publicId: newPublicId(),
        type: "BOOKING",
        bookingId: reservation.id,
        residenceId: reservation.residenceId,
        participants: {
          create: [
            { userId: reservation.guestId, role: "GUEST" },
            { userId: reservation.hostId, role: "HOST" },
          ],
        },
      },
    });

    await appendSystemMessage(conversation.id, {
      kind: "BOOKING_CREATED",
      reference: reservation.reference,
      residenceId: publicResidenceId(reservation.residence),
      residenceName: reservation.residence.name,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      guestsCount: reservation.guestsCount + reservation.extraGuestsCount,
    });

    return conversation;
  } catch (error) {
    // Someone else created it between the read and the write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.conversation.findUnique({ where: { bookingId: reservationId } });
      if (raced) return raced;
    }
    throw error;
  }
}

/** A support thread, opened by the user. Admins join it when they answer. */
export async function createSupportConversation(userId: number, subject: string, body: string) {
  const conversation = await prisma.conversation.create({
    data: {
      publicId: newPublicId(),
      type: "SUPPORT",
      subject: subject.slice(0, 120),
      participants: { create: [{ userId, role: "GUEST" }] },
    },
  });

  await sendMessage({
    conversationId: conversation.id,
    senderId: userId,
    senderRole: "GUEST",
    body,
  });

  return conversation;
}

// ------------------------------------------------------------- messages ---

export interface SystemMeta {
  kind:
    | "BOOKING_CREATED"
    | "BOOKING_APPROVED"
    | "BOOKING_CANCELLED"
    | "BOOKING_EXPIRED"
    | "BOOKING_COMPLETED"
    | "ADMIN_JOINED";
  [key: string]: unknown;
}

/**
 * A system message. Carries structured meta so the front renders a status
 * card rather than parsing a sentence back apart.
 */
export async function appendSystemMessage(conversationId: number, meta: SystemMeta) {
  return sendMessage({
    conversationId,
    senderId: null,
    senderRole: null,
    type: "SYSTEM",
    body: systemText(meta),
    meta,
    notify: false,
  });
}

function faDate(value: unknown): string {
  if (!(value instanceof Date)) return "";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(value);
}

/**
 * The plain-text fallback for a system message.
 *
 * Stored alongside the meta so a client that does not know a `kind` — an older
 * app build, the admin list's one-line preview, the SMS — still has something
 * true to show.
 */
function systemText(meta: SystemMeta): string {
  switch (meta.kind) {
    case "BOOKING_CREATED":
      return `درخواست رزرو «${meta.residenceName}» ثبت شد — از ${faDate(meta.startDate)} تا ${faDate(
        meta.endDate
      )} برای ${meta.guestsCount} مهمان.`;
    case "BOOKING_APPROVED":
      return "رزرو تأیید شد و در انتظار پرداخت است.";
    case "BOOKING_CANCELLED":
      return `رزرو لغو شد${meta.reason ? ` — ${meta.reason}` : ""}.`;
    case "BOOKING_EXPIRED":
      return "مهلت این رزرو به پایان رسید.";
    case "BOOKING_COMPLETED":
      return "رزرو تکمیل شد. سفر خوبی داشته باشید!";
    case "ADMIN_JOINED":
      return "پشتیبانی لیدوماتریپ وارد گفتگو شد.";
    default:
      return "";
  }
}

export interface SendMessageInput {
  conversationId: number;
  senderId: number | null;
  senderRole: ParticipantRole | null;
  body: string;
  type?: MessageType;
  meta?: unknown;
  clientNonce?: string | null;
  attachment?: { url: string; name: string; size: number } | null;
  /** SYSTEM messages announce something the reader is already being told elsewhere. */
  notify?: boolean;
}

/**
 * Writes a message and updates everything that hangs off it.
 *
 * One transaction covers the message, the conversation's denormalised tail,
 * and every other participant's unread counter — a message that lands without
 * bumping the badge is a message nobody knows arrived.
 *
 * A repeated clientNonce returns the original message instead of a second one.
 * That is what makes the optimistic send on the front safe to retry.
 */
export async function sendMessage(input: SendMessageInput) {
  const type = input.type ?? "TEXT";
  const body = type === "SYSTEM" ? input.body : normalizeBody(input.body);

  if (!body && !input.attachment) throw AppError.badRequest("متن پیام خالی است");

  if (input.clientNonce) {
    const duplicate = await prisma.message.findUnique({
      where: {
        conversationId_clientNonce: {
          conversationId: input.conversationId,
          clientNonce: input.clientNonce,
        },
      },
      select: MESSAGE_SELECT,
    });
    if (duplicate) return toMessage(duplicate);
  }

  const flagged = type === "TEXT" && looksOffPlatform(body);
  const preview = previewOf(body, type);

  const created = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.senderId,
        senderRole: input.senderRole,
        type,
        body,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        clientNonce: input.clientNonce ?? null,
        attachmentUrl: input.attachment?.url ?? null,
        attachmentName: input.attachment?.name ?? null,
        attachmentSize: input.attachment?.size ?? null,
        flagged,
      },
      select: MESSAGE_SELECT,
    });

    await tx.conversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessageAt: message.createdAt,
        lastMessagePreview: preview,
        // A user's reply reopens a thread support had marked as answered.
        ...(input.senderRole === "GUEST" || input.senderRole === "HOST"
          ? { status: "OPEN" as const }
          : {}),
      },
    });

    // An internal note is invisible to the user, so it must not light up
    // their unread badge.
    if (type !== "INTERNAL_NOTE") {
      await tx.conversationParticipant.updateMany({
        where: {
          conversationId: input.conversationId,
          ...(input.senderId ? { userId: { not: input.senderId } } : {}),
        },
        data: { unreadCount: { increment: 1 } },
      });
    }

    // The sender has, by definition, read their own message.
    if (input.senderId) {
      await tx.conversationParticipant.updateMany({
        where: { conversationId: input.conversationId, userId: input.senderId },
        data: { unreadCount: 0, lastReadAt: message.createdAt, lastReadMessageId: message.id },
      });
    }

    return message;
  });

  const payload = toMessage(created);
  await fanOut(input.conversationId, payload, type);

  if (input.notify !== false && type !== "INTERNAL_NOTE" && type !== "SYSTEM") {
    // Deliberately not awaited: an SMS provider having a slow morning must not
    // hold up the sender's request.
    void notifyNewMessage(input.conversationId, input.senderId, body);
  }

  return payload;
}

/** Pushes a new message to everyone who should see it, live. */
async function fanOut(conversationId: number, message: ReturnType<typeof toMessage>, type: MessageType) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      publicId: true,
      participants: { select: { userId: true, role: true, unreadCount: true } },
    },
  });
  if (!conversation) return;

  for (const participant of conversation.participants) {
    // An internal note reaches admins only, and only in the panel.
    if (type === "INTERNAL_NOTE" && participant.role !== "ADMIN") continue;

    publish({
      userId: participant.userId,
      type: "message",
      payload: {
        conversation_id: conversation.publicId,
        message,
        unread_count: participant.unreadCount,
      },
    });
  }
}

// --------------------------------------------------------------- reading ---

/**
 * The caller's conversation list.
 *
 * One query. The last message and its time live on the conversation row, so
 * this does not walk into the messages table once per thread — the shape of
 * query that made the home page take two seconds.
 */
export async function listConversations(
  userId: number,
  opts: { type?: ConversationType; archived?: boolean; take?: number; cursor?: number } = {}
) {
  const take = Math.min(opts.take ?? 20, 50);

  const rows = await prisma.conversationParticipant.findMany({
    where: {
      userId,
      leftAt: null,
      conversation: {
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.archived ? { status: "CLOSED" } : { status: { not: "CLOSED" } }),
      },
    },
    select: {
      unreadCount: true,
      role: true,
      isMuted: true,
      conversation: {
        select: {
          id: true,
          publicId: true,
          type: true,
          status: true,
          subject: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          createdAt: true,
          booking: { select: { reference: true, startDate: true, endDate: true, state: true } },
          residence: {
            select: { id: true, name: true, reference: true, images: { select: { url: true }, orderBy: [{ isMain: "desc" }, { sortOrder: "asc" }], take: 1 } },
          },
          participants: { select: PARTICIPANT_SELECT },
        },
      },
    },
    orderBy: { conversation: { lastMessageAt: "desc" } },
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });

  const page = rows.slice(0, take);

  return {
    items: page.map((row) => {
      const c = row.conversation;
      // Who the reader is talking to. For support that is the site itself,
      // which has no user row — hence the null and the fixed label on the front.
      const peer = c.participants.find((p) => p.user.id !== userId && p.role !== "ADMIN") ?? null;

      return {
        id: c.publicId,
        type: c.type,
        status: c.status,
        subject: c.subject,
        unread_count: row.unreadCount,
        is_muted: row.isMuted,
        my_role: row.role,
        peer: peer
          ? { id: peer.user.id, name: peer.user.name, avatar: peer.user.avatarUrl }
          : null,
        residence: c.residence
          ? {
              id: publicResidenceId(c.residence),
              name: c.residence.name,
              image: c.residence.images[0]?.url ?? null,
            }
          : null,
        booking: c.booking
          ? {
              reference: c.booking.reference,
              start_date: c.booking.startDate,
              end_date: c.booking.endDate,
              state: c.booking.state,
            }
          : null,
        last_message: c.lastMessagePreview,
        last_message_at: c.lastMessageAt ?? c.createdAt,
      };
    }),
    next_cursor: rows.length > take ? page[page.length - 1]?.conversation.id ?? null : null,
  };
}

/**
 * A page of messages, newest first, walking backwards.
 *
 * Cursor, not offset: a thread that receives a message between page one and
 * page two would otherwise repeat a message or drop one.
 */
export async function listMessages(
  conversationId: number,
  opts: { before?: number; take?: number; includeInternal?: boolean } = {}
) {
  const take = Math.min(opts.take ?? PAGE_SIZE, 100);

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(opts.before ? { id: { lt: opts.before } } : {}),
      ...(opts.includeInternal ? {} : { type: { not: "INTERNAL_NOTE" } }),
    },
    select: MESSAGE_SELECT,
    orderBy: { id: "desc" },
    take: take + 1,
  });

  const page = rows.slice(0, take);

  return {
    // Ascending for the reader; the query walks backwards only to page.
    items: page.map(toMessage).reverse(),
    has_more: rows.length > take,
    next_before: rows.length > take ? page[page.length - 1]?.id ?? null : null,
  };
}

/** Marks the thread read for one participant and tells their other tabs. */
export async function markRead(conversationId: number, userId: number, upToMessageId?: number) {
  const last =
    upToMessageId ??
    (
      await prisma.message.findFirst({
        where: { conversationId },
        orderBy: { id: "desc" },
        select: { id: true },
      })
    )?.id;

  const updated = await prisma.conversationParticipant.updateMany({
    where: { conversationId, userId },
    data: { unreadCount: 0, lastReadAt: new Date(), lastReadMessageId: last ?? null },
  });
  if (!updated.count) return { unread_count: 0 };

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { publicId: true, participants: { select: { userId: true } } },
  });

  if (conversation) {
    // The reader's own tabs clear the badge; the other side gets a read receipt.
    for (const participant of conversation.participants) {
      publish({
        userId: participant.userId,
        type: "read",
        payload: {
          conversation_id: conversation.publicId,
          reader_id: userId,
          last_read_message_id: last ?? null,
        },
      });
    }
  }

  return { unread_count: 0 };
}

/** The header badge: one sum, no join into messages. */
export async function unreadTotal(userId: number) {
  const result = await prisma.conversationParticipant.aggregate({
    where: { userId, leftAt: null, isMuted: false, conversation: { status: { not: "CLOSED" } } },
    _sum: { unreadCount: true },
  });
  return result._sum.unreadCount ?? 0;
}

export async function setMuted(conversationId: number, userId: number, isMuted: boolean) {
  await prisma.conversationParticipant.updateMany({
    where: { conversationId, userId },
    data: { isMuted },
  });
  return { is_muted: isMuted };
}

/** Ephemeral: published, never stored. */
export async function broadcastTyping(conversationId: number, userId: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { publicId: true, participants: { select: { userId: true } } },
  });
  if (!conversation) return;

  for (const participant of conversation.participants) {
    if (participant.userId === userId) continue;
    publish({
      userId: participant.userId,
      type: "typing",
      payload: { conversation_id: conversation.publicId, user_id: userId },
    });
  }
}

export { PARTICIPANT_SELECT, MESSAGE_SELECT, toMessage, newPublicId };

// ---------------------------------------------------------------- admin ---

/**
 * Puts an admin into a thread they were not part of, announced.
 *
 * Support threads work as a pool — admins are not participants, or every
 * ticket would land in every admin's own conversation list — so the first one
 * to answer joins here. A booking thread between a host and a guest gets the
 * same treatment, plus a system message: an unannounced third voice in what
 * both sides believe is a private conversation is the sort of thing that
 * destroys trust the moment somebody notices.
 */
export async function joinAsAdmin(conversationId: number, userId: number): Promise<ParticipantRole> {
  const existing = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true },
  });
  if (existing) return "ADMIN";

  await prisma.conversationParticipant.create({
    data: { conversationId, userId, role: "ADMIN" },
  });

  await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAdminId: null },
    data: { assignedAdminId: userId },
  });

  await appendSystemMessage(conversationId, { kind: "ADMIN_JOINED" });

  return "ADMIN";
}

/** The panel's list. Offset paging is fine here: an admin queue is browsed, not streamed. */
export async function adminListConversations(opts: {
  type?: ConversationType;
  status?: "OPEN" | "PENDING" | "CLOSED";
  q?: string;
  flagged?: boolean;
  unassigned?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 20, 100);

  const where: Prisma.ConversationWhereInput = {
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.unassigned ? { assignedAdminId: null } : {}),
    ...(opts.flagged ? { messages: { some: { flagged: true } } } : {}),
    ...(opts.q
      ? {
          OR: [
            { subject: { contains: opts.q, mode: "insensitive" } },
            { booking: { reference: { contains: opts.q, mode: "insensitive" } } },
            { residence: { name: { contains: opts.q, mode: "insensitive" } } },
            { participants: { some: { user: { name: { contains: opts.q, mode: "insensitive" } } } } },
            { participants: { some: { user: { phone: { contains: opts.q } } } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      select: {
        id: true,
        publicId: true,
        type: true,
        status: true,
        subject: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        createdAt: true,
        assignedAdmin: { select: { id: true, name: true } },
        residence: { select: { id: true, name: true, reference: true } },
        booking: { select: { reference: true, state: true } },
        participants: {
          select: { role: true, user: { select: { id: true, name: true, phone: true } } },
        },
        _count: { select: { messages: { where: { flagged: true } } } },
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      public_id: row.publicId,
      type: row.type,
      status: row.status,
      subject: row.subject,
      last_message: row.lastMessagePreview,
      last_message_at: row.lastMessageAt ?? row.createdAt,
      assigned_admin: row.assignedAdmin,
      residence: row.residence
        ? { id: publicResidenceId(row.residence), name: row.residence.name }
        : null,
      booking: row.booking,
      flagged_count: row._count.messages,
      participants: row.participants.map((p) => ({
        role: p.role,
        id: p.user.id,
        name: p.user.name,
        phone: p.user.phone,
      })),
    })),
    total,
    page,
    pageSize,
  };
}

/** One thread, in full, internal notes included. */
export async function adminGetConversation(id: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      publicId: true,
      type: true,
      status: true,
      subject: true,
      createdAt: true,
      assignedAdmin: { select: { id: true, name: true } },
      residence: { select: { id: true, name: true, reference: true } },
      booking: {
        select: {
          id: true,
          reference: true,
          startDate: true,
          endDate: true,
          guestsCount: true,
          state: true,
          totalAmount: true,
        },
      },
      participants: { select: PARTICIPANT_SELECT },
    },
  });
  if (!conversation) throw AppError.notFound("گفتگو پیدا نشد");

  const messages = await listMessages(id, { take: 100, includeInternal: true });

  return {
    ...conversation,
    residence: conversation.residence
      ? { id: publicResidenceId(conversation.residence), name: conversation.residence.name }
      : null,
    messages: messages.items,
    has_more: messages.has_more,
    next_before: messages.next_before,
  };
}

export async function adminUpdateConversation(
  id: number,
  adminId: number,
  data: { status?: "OPEN" | "PENDING" | "CLOSED"; assignToMe?: boolean }
) {
  if (data.assignToMe) await joinAsAdmin(id, adminId);

  return prisma.conversation.update({
    where: { id },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.assignToMe ? { assignedAdminId: adminId } : {}),
    },
    select: { id: true, status: true, assignedAdminId: true },
  });
}

/**
 * Soft delete. The message keeps its place in the thread as a tombstone —
 * see toMessage — rather than leaving the other side with a gap where they
 * remember something being said.
 */
export async function adminDeleteMessage(messageId: number) {
  const message = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
    select: { id: true, conversationId: true },
  });

  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    select: { publicId: true, participants: { select: { userId: true } } },
  });

  if (conversation) {
    for (const participant of conversation.participants) {
      publish({
        userId: participant.userId,
        type: "message-deleted",
        payload: { conversation_id: conversation.publicId, message_id: message.id },
      });
    }
  }

  return { id: message.id, deleted: true };
}

export async function adminStats() {
  const [openSupport, unassigned, flagged] = await Promise.all([
    prisma.conversation.count({ where: { type: "SUPPORT", status: "OPEN" } }),
    prisma.conversation.count({ where: { type: "SUPPORT", assignedAdminId: null, status: { not: "CLOSED" } } }),
    prisma.conversation.count({ where: { messages: { some: { flagged: true } } } }),
  ]);
  return { open_support: openSupport, unassigned, flagged };
}
