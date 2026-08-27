import crypto from "crypto";
import { env } from "@/config/env";
import { sendSms } from "@/lib/sms";

export function generateOtpCode(): string {
  const max = 10 ** env.otp.codeLength;
  const code = crypto.randomInt(0, max);
  return code.toString().padStart(env.otp.codeLength, "0");
}

export function hashOtpCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function otpExpiryDate(): Date {
  return new Date(Date.now() + env.otp.ttlSeconds * 1000);
}

/**
 * Sends the OTP code by SMS.
 *
 * The provider integration lives in lib/sms.ts, which is also what chat
 * notifications use — one place to wire a real provider into rather than two
 * stubs, one of which would get forgotten.
 */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  await sendSms(phone, `کد ورود شما به لیدوماتریپ: ${code}`);
}
