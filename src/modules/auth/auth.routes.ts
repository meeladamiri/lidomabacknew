import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { requireAuth } from "@/middleware/auth";
import {
  passwordLoginSchema,
  refreshSchema,
  requestOtpSchema,
  setPasswordSchema,
  verifyOtpSchema,
} from "./auth.schema";
import * as controller from "./auth.controller";

const router = Router();

// Throttle OTP requests hard — this is the most abuse-prone endpoint (SMS cost + brute force).
const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", code: "TOO_MANY_REQUESTS", message: "تعداد درخواست‌ها بیش از حد مجاز است" },
});

router.post(
  "/otp/request",
  otpRequestLimiter,
  validate(requestOtpSchema),
  asyncHandler(controller.requestOtp)
);
router.post("/otp/verify", validate(verifyOtpSchema), asyncHandler(controller.verifyOtp));
router.post(
  "/login/password",
  validate(passwordLoginSchema),
  asyncHandler(controller.loginWithPassword)
);
router.post(
  "/password",
  requireAuth,
  validate(setPasswordSchema),
  asyncHandler(controller.setPassword)
);
router.post("/refresh", validate(refreshSchema), asyncHandler(controller.refresh));
router.post("/logout", asyncHandler(controller.logout));
router.get("/me", requireAuth, asyncHandler(controller.me));

export default router;
