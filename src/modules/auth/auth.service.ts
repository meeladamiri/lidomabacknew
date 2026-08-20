import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { generateOtpCode, hashOtpCode, otpExpiryDate, sendOtpSms } from "@/lib/otp";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "@/lib/jwt";
import { env } from "@/config/env";

const MAX_OTP_ATTEMPTS = 5;

export async function requestOtp(phone: string) {
  const existingUser = await prisma.user.findUnique({ where: { phone } });
  const purpose = existingUser ? "LOGIN" : "SIGNUP";

  const code = generateOtpCode();
  await prisma.otpCode.create({
    data: {
      phone,
      userId: existingUser?.id,
      codeHash: hashOtpCode(code),
      purpose,
      expiresAt: otpExpiryDate(),
    },
  });

  await sendOtpSms(phone, code);

  return { exists: Boolean(existingUser), ttlSeconds: env.otp.ttlSeconds };
}

async function issueTokens(userId: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    isHost: user.isHost,
  });
  const refreshToken = signRefreshToken(user.id);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30d, mirrors JWT_REFRESH_TTL default
    },
  });

  return { accessToken, refreshToken, user };
}

export async function verifyOtp(phone: string, code: string, name?: string) {
  const otp = await prisma.otpCode.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    throw AppError.badRequest("کد فعال‌سازی برای این شماره یافت نشد", "OTP_NOT_FOUND");
  }
  if (otp.expiresAt < new Date()) {
    throw AppError.badRequest("کد فعال‌سازی منقضی شده است", "OTP_EXPIRED");
  }
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    throw AppError.tooMany("تعداد تلاش‌های مجاز برای این کد به پایان رسیده است");
  }
  if (otp.codeHash !== hashOtpCode(code)) {
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw AppError.badRequest("کد فعال‌سازی نادرست است", "OTP_INVALID");
  }

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() },
  });

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone,
        name: name ?? null,
        verificationStatus: "NOT_CONFIRMED",
      },
    });
  }

  return issueTokens(user.id);
}

export async function loginWithPassword(phone: string, password: string) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user?.passwordHash) {
    throw AppError.badRequest("رمز عبوری برای این شماره ثبت نشده است", "PASSWORD_NOT_SET");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    throw AppError.badRequest("شماره موبایل یا رمز عبور اشتباه است", "INVALID_CREDENTIALS");
  }

  return issueTokens(user.id);
}

export async function setPassword(userId: number, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}

export async function refreshTokens(refreshToken: string) {
  let payload: { sub: number };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw AppError.unauthorized("رفرش توکن نامعتبر یا منقضی شده است");
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw AppError.unauthorized("رفرش توکن نامعتبر یا منقضی شده است");
  }

  // rotate: revoke old, issue new
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return issueTokens(payload.sub);
}

export async function logout(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
