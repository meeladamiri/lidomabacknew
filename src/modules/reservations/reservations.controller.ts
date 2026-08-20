import { Request, Response } from "express";
import { created, ok } from "@/utils/response";
import { AppError } from "@/lib/errors";
import * as service from "./reservations.service";

function userId(req: Request): number {
  if (!req.user) throw AppError.unauthorized();
  return req.user.sub;
}

export async function create(req: Request, res: Response) {
  const data = await service.createReservation(userId(req), req.body);
  return created(res, data);
}

export async function mine(req: Request, res: Response) {
  const data = await service.listGuestReservations(userId(req));
  return ok(res, data);
}

export async function detail(req: Request, res: Response) {
  const data = await service.getReservationDetail(userId(req), Number(req.params.id));
  return ok(res, data);
}

export async function guestCancel(req: Request, res: Response) {
  const data = await service.guestCancelReservation(userId(req), Number(req.params.id), req.body.reason);
  return ok(res, data);
}

// Host-side

export async function hostList(req: Request, res: Response) {
  const data = await service.listHostReservations(userId(req));
  return ok(res, data);
}

export async function accept(req: Request, res: Response) {
  const data = await service.acceptReservation(userId(req), Number(req.params.id));
  return ok(res, data);
}

export async function reject(req: Request, res: Response) {
  const data = await service.rejectReservation(userId(req), Number(req.params.id), req.body.reason, req.body.desc);
  return ok(res, data);
}

export async function hostCancel(req: Request, res: Response) {
  const data = await service.hostCancelReservation(userId(req), Number(req.params.id), req.body.reason, req.body.desc);
  return ok(res, data);
}
