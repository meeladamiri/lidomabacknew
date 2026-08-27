import { Request, Response } from "express";
import { ok, created } from "@/utils/response";
import { publicResidenceId } from "@/lib/publicId";
import * as service from "./conversations.service";

function actor(req: Request) {
  return { userId: req.user!.sub, isAdmin: req.user!.role === "ADMIN" };
}

export async function list(req: Request, res: Response) {
  const { userId } = actor(req);
  const { type, archived, cursor, take } = req.query as unknown as {
    type?: "BOOKING" | "SUPPORT";
    archived?: boolean;
    cursor?: number;
    take?: number;
  };
  return ok(res, await service.listConversations(userId, { type, archived, cursor, take }));
}

export async function unreadCount(req: Request, res: Response) {
  return ok(res, { count: await service.unreadTotal(req.user!.sub) });
}

export async function detail(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation, me } = await service.requireAccess(req.params.publicId, userId, isAdmin);

  const peer =
    conversation.participants.find((p) => p.user.id !== userId && p.role !== "ADMIN") ?? null;

  return ok(res, {
    id: conversation.publicId,
    type: conversation.type,
    status: conversation.status,
    subject: conversation.subject,
    my_role: me?.role ?? "ADMIN",
    is_muted: me?.isMuted ?? false,
    unread_count: me?.unreadCount ?? 0,
    peer: peer ? { id: peer.user.id, name: peer.user.name, avatar: peer.user.avatarUrl } : null,
    // Read receipts: how far the other side has got.
    peer_last_read_message_id: peer?.lastReadMessageId ?? null,
    residence: conversation.residence
      ? {
          id: publicResidenceId(conversation.residence),
          name: conversation.residence.name,
          image: conversation.residence.images[0]?.url ?? null,
        }
      : null,
    booking: conversation.booking
      ? {
          reference: conversation.booking.reference,
          start_date: conversation.booking.startDate,
          end_date: conversation.booking.endDate,
          guests_count: conversation.booking.guestsCount,
          state: conversation.booking.state,
          total_amount: conversation.booking.totalAmount,
        }
      : null,
  });
}

export async function messages(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation } = await service.requireAccess(req.params.publicId, userId, isAdmin);
  const { before, take } = req.query as unknown as { before?: number; take?: number };

  return ok(
    res,
    await service.listMessages(conversation.id, {
      before,
      take,
      // Internal notes are for the panel. Even an admin reading a thread
      // through the user-facing endpoint should see what the user sees.
      includeInternal: false,
    })
  );
}

export async function send(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation, me } = await service.requireAccess(req.params.publicId, userId, isAdmin);
  const { body, client_nonce, attachment } = req.body as {
    body: string;
    client_nonce?: string;
    attachment?: { url: string; name: string; size: number };
  };

  // An admin writing into a thread they are not part of joins it visibly.
  // A silent third voice in what both sides believe is a private conversation
  // is the kind of thing that destroys trust the moment it surfaces.
  const role = me?.role ?? (await service.joinAsAdmin(conversation.id, userId));

  const message = await service.sendMessage({
    conversationId: conversation.id,
    senderId: userId,
    senderRole: role,
    body,
    type: attachment ? "IMAGE" : "TEXT",
    clientNonce: client_nonce ?? null,
    attachment: attachment ?? null,
  });

  return created(res, message);
}

export async function read(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation } = await service.requireAccess(req.params.publicId, userId, isAdmin);
  const { last_message_id } = req.body as { last_message_id?: number };
  return ok(res, await service.markRead(conversation.id, userId, last_message_id));
}

export async function typing(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation } = await service.requireAccess(req.params.publicId, userId, isAdmin);
  await service.broadcastTyping(conversation.id, userId);
  return ok(res, { ok: true });
}

export async function mute(req: Request, res: Response) {
  const { userId, isAdmin } = actor(req);
  const { conversation } = await service.requireAccess(req.params.publicId, userId, isAdmin);
  const { is_muted } = req.body as { is_muted: boolean };
  return ok(res, await service.setMuted(conversation.id, userId, is_muted));
}

export async function createSupport(req: Request, res: Response) {
  const { subject, body } = req.body as { subject: string; body: string };
  const conversation = await service.createSupportConversation(req.user!.sub, subject, body);
  return created(res, { id: conversation.publicId });
}
