import crypto from "crypto";
import { env } from "@/config/env";

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
 * Sends the OTP code via SMS provider.
 * NOTE: this is a stub — wire it to the real SMS provider (e.g. Kavenegar,
 * Melipayamak, ...) using env.otp.smsApiKey / env.otp.smsSender.
 * In non-production environments it just logs the code so development can
 * proceed without a live SMS account.
 */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (!env.otp.smsApiKey) {
    // eslint-disable-next-line no-console
    console.warn(`[OTP][DEV] SMS provider not configured. Code for ${phone}: ${code}`);
    return;
  }

  // TODO: integrate real SMS provider HTTP call here.
  // eslint-disable-next-line no-console
  console.log(`[OTP] would send "${code}" to ${phone} via configured provider`);
}
