import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import crypto from "crypto";
import { env } from "@/config/env";
import { AppError } from "@/lib/errors";

export interface AccessTokenPayload {
  sub: number; // شناسه کاربر
  role: "USER" | "ADMIN";
  isHost: boolean;
}

function getJwtPayload(decoded: string | JwtPayload): JwtPayload {
  if (typeof decoded === "string") {
    throw AppError.unauthorized("توکن نامعتبر است");
  }

  return decoded;
}

function parseUserId(sub: unknown): number {
  const userId = Number(sub);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw AppError.unauthorized("شناسه کاربر در توکن نامعتبر است");
  }

  return userId;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = getJwtPayload(jwt.verify(token, env.jwt.accessSecret));

    if (
      (decoded.role !== "USER" && decoded.role !== "ADMIN") ||
      typeof decoded.isHost !== "boolean"
    ) {
      throw AppError.unauthorized("اطلاعات توکن نامعتبر است");
    }

    return {
      sub: parseUserId(decoded.sub),
      role: decoded.role,
      isHost: decoded.isHost,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw AppError.unauthorized("توکن نامعتبر یا منقضی شده است");
  }
}

export function signRefreshToken(userId: number): string {
  return jwt.sign(
    { sub: userId },
    env.jwt.refreshSecret,
    {
      expiresIn: env.jwt.refreshTtl,
    } as SignOptions
  );
}

export function verifyRefreshToken(token: string): { sub: number } {
  try {
    const decoded = getJwtPayload(jwt.verify(token, env.jwt.refreshSecret));

    return {
      sub: parseUserId(decoded.sub),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw AppError.unauthorized("توکن رفرش نامعتبر یا منقضی شده است");
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
