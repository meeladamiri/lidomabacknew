import { NextFunction, Request, Response } from "express";
import { AppError } from "@/lib/errors";
import { AccessTokenPayload, verifyAccessToken } from "@/lib/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  if (req.cookies?.access_token) {
    return req.cookies.access_token as string;
  }
  return null;
}

/** Requires a valid access token. Rejects with 401 otherwise. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return next(AppError.unauthorized());
  }
  try {
    req.user = verifyAccessToken(token);
    return next();
  } catch {
    return next(AppError.unauthorized("توکن نامعتبر یا منقضی شده است"));
  }
}

/** Populates req.user if a valid token is present, but never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // ignore invalid/expired token for optional auth
    }
  }
  return next();
}

/** Requires the authenticated user to be an admin. Must run after requireAuth. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(AppError.unauthorized());
  }
  if (req.user.role !== "ADMIN") {
    return next(AppError.forbidden("این عملیات فقط برای ادمین مجاز است"));
  }
  return next();
}

/** Requires the authenticated user to have the host flag. Must run after requireAuth. */
export function requireHost(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(AppError.unauthorized());
  }
  if (!req.user.isHost && req.user.role !== "ADMIN") {
    return next(AppError.forbidden("این عملیات فقط برای میزبانان مجاز است"));
  }
  return next();
}
