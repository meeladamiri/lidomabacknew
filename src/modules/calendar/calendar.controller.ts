import { Request, Response } from "express";
import { resolvePublicResidenceId } from "@/lib/publicId";
import { ok } from "@/utils/response";
import { AppError } from "@/lib/errors";
import * as service from "./calendar.service";

export async function getCalendar(req: Request, res: Response) {
  const { roomId, from, to } = req.query as { roomId?: string; from: string; to: string };
  // public route — the page carries the legacy Odoo id for migrated residences
  const residenceId = await resolvePublicResidenceId(Number(req.params.id));
  const data = await service.getCalendar(residenceId, roomId ? Number(roomId) : undefined, from, to);
  return ok(res, data);
}

export async function updateCalendar(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  const data = await service.updateCalendar(req.user.sub, Number(req.params.id), req.body);
  return ok(res, data);
}
