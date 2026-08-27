/**
 * The one place an SMS leaves this application.
 *
 * There were two callers coming: the OTP code, which already had its own
 * inline stub, and chat notifications. Two stubs means two places to wire the
 * provider into and one of them getting forgotten, so both go through here.
 *
 * Still a stub. `env.otp.smsApiKey` unset logs instead of sending, which is
 * what keeps local development working without a live SMS account.
 */

import { env } from "@/config/env";

export async function sendSms(phone: string, text: string): Promise<void> {
  if (!env.otp.smsApiKey) {
    console.warn(`[sms][dev] provider not configured. To ${phone}: ${text}`);
    return;
  }

  // TODO: the real provider call goes here (Kavenegar, Melipayamak, ...).
  // Deliberately swallowing failures: no SMS is ever worth failing the
  // request that triggered it.
  try {
    console.log(`[sms] would send to ${phone}: ${text}`);
  } catch (error) {
    console.warn(`[sms] send failed: ${(error as Error).message}`);
  }
}
