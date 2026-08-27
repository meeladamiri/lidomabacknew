import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import * as controller from "./conversations.controller";
import { streamHandler } from "./realtime";
import {
  conversationParamSchema,
  createSupportSchema,
  listConversationsSchema,
  listMessagesSchema,
  markReadSchema,
  muteSchema,
  sendMessageSchema,
} from "./conversations.schema";

const router = Router();

router.use(requireAuth);

/**
 * A human writing to another human does not send sixty messages a minute.
 * Keyed by user rather than IP: several guests behind one mobile carrier NAT
 * share an address, and throttling them as one would be indistinguishable
 * from the site being broken.
 */
const sendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.sub ?? req.ip),
  message: { status: "error", message: "پیام‌های زیادی فرستادید. کمی صبر کنید." },
});

/** Opening a support ticket is rarer still, and cheap to abuse. */
const supportLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.sub ?? req.ip),
  message: { status: "error", message: "تعداد درخواست‌های پشتیبانی زیاد است." },
});

// Fixed paths first: /unread-count and /stream must not be read as a :publicId.
router.get("/unread-count", asyncHandler(controller.unreadCount));
router.get("/stream", streamHandler);
router.post("/support", supportLimiter, validate(createSupportSchema), asyncHandler(controller.createSupport));

router.get("/", validate(listConversationsSchema), asyncHandler(controller.list));
router.get("/:publicId", validate(conversationParamSchema), asyncHandler(controller.detail));
router.get("/:publicId/messages", validate(listMessagesSchema), asyncHandler(controller.messages));
router.post(
  "/:publicId/messages",
  sendLimiter,
  validate(sendMessageSchema),
  asyncHandler(controller.send)
);
router.post("/:publicId/read", validate(markReadSchema), asyncHandler(controller.read));
router.post("/:publicId/typing", validate(conversationParamSchema), asyncHandler(controller.typing));
router.post("/:publicId/mute", validate(muteSchema), asyncHandler(controller.mute));

export default router;
