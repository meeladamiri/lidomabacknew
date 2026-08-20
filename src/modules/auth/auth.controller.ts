import { Request, Response } from "express";
import { ok } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import * as authService from "./auth.service";

function publicUser(user: {
  id: number;
  phone: string;
  name: string | null;
  isHost: boolean;
  role: string;
  avatarUrl: string | null;
  verificationStatus: string;
}) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    isHost: user.isHost,
    role: user.role,
    avatarUrl: user.avatarUrl,
    verificationStatus: user.verificationStatus,
  };
}

export async function requestOtp(req: Request, res: Response) {
  const { phone } = req.body;
  const result = await authService.requestOtp(phone);
  return ok(res, result);
}

export async function verifyOtp(req: Request, res: Response) {
  const { phone, code, name } = req.body;
  const { accessToken, refreshToken, user } = await authService.verifyOtp(phone, code, name);
  return ok(res, { accessToken, refreshToken, user: publicUser(user) });
}

export async function loginWithPassword(req: Request, res: Response) {
  const { phone, password } = req.body;
  const { accessToken, refreshToken, user } = await authService.loginWithPassword(phone, password);
  return ok(res, { accessToken, refreshToken, user: publicUser(user) });
}

export async function setPassword(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  await authService.setPassword(req.user.sub, req.body.password);
  return ok(res, { success: true });
}

export async function refresh(req: Request, res: Response) {
  const { refreshToken } = req.body;
  const result = await authService.refreshTokens(refreshToken);
  return ok(res, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: publicUser(result.user),
  });
}

export async function logout(req: Request, res: Response) {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await authService.logout(refreshToken);
  }
  return ok(res, { success: true });
}

export async function me(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
  return ok(res, publicUser(user));
}
