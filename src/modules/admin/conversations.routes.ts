/**
 * Conversation management for the panel.
 *
 * Separate from the user-facing router because the visibility rules differ in
 * both directions: an admin sees internal notes and every thread regardless of
 * membership, and an admin's reply has to announce itself rather than appear
 * as a third voice in a conversation two people believe is private.
 */

import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import * as service from "@/modules/conversations/conversations.service";
import {
  adminIdParamSchema,
  adminListSchema,
  adminMessageParamSchema,
  adminSendSchema,
  adminUpdateSchema,
} from "@/modules/conversations/conversations.schema";

const router = Router();

router.get(
  "/stats",
  asyncHandler(async (_req, res) => ok(res, await service.adminStats()))
);

router.get(
  "/",
  validate(adminListSchema),
  asyncHandler(async (req, res) => {
    const { type, status, q, flagged, unassigned, page, pageSize } = req.query as unknown as {
      type?: "BOOKING" | "SUPPORT";
      status?: "OPEN" | "PENDING" | "CLOSED";
      q?: string;
      flagged?: boolean;
      unassigned?: boolean;
      page?: number;
      pageSize?: number;
    };
    return ok(
      res,
      await service.adminListConversations({ type, status, q, flagged, unassigned, page, pageSize })
    );
  })
);

router.get(
  "/:id",
  validate(adminIdParamSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.adminGetConversation(Number(req.params.id)))
  )
);

router.post(
  "/:id/messages",
  validate(adminSendSchema),
  asyncHandler(async (req, res) => {
    const conversationId = Number(req.params.id);
    const adminId = req.user!.sub;
    const { body, internal } = req.body as { body: string; internal?: boolean };

    // An internal note stays in the panel, so it does not put the admin's name
    // into the thread the participants can see.
    if (!internal) await service.joinAsAdmin(conversationId, adminId);

    return ok(
      res,
      await service.sendMessage({
        conversationId,
        senderId: adminId,
        senderRole: "ADMIN",
        type: internal ? "INTERNAL_NOTE" : "TEXT",
        body,
        // Support answering is exactly when a text message is worth sending:
        // the user asked a question and has gone away.
        notify: !internal,
      })
    );
  })
);

router.patch(
  "/:id",
  validate(adminUpdateSchema),
  asyncHandler(async (req, res) => {
    const { status, assign_to_me } = req.body as {
      status?: "OPEN" | "PENDING" | "CLOSED";
      assign_to_me?: boolean;
    };
    return ok(
      res,
      await service.adminUpdateConversation(Number(req.params.id), req.user!.sub, {
        status,
        assignToMe: assign_to_me,
      })
    );
  })
);

router.delete(
  "/messages/:messageId",
  validate(adminMessageParamSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.adminDeleteMessage(Number(req.params.messageId)))
  )
);

export default router;
