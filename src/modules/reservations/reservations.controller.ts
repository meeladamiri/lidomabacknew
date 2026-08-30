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

export async function getMyReview(req: Request, res: Response) {
  const data = await service.getMyReview(userId(req), Number(req.params.id));
  return ok(res, data);
}

export async function submitReview(req: Request, res: Response) {
  const { comment, ...scores } = req.body;
  const data = await service.submitReview(userId(req), Number(req.params.id), scores, comment);
  return created(res, data);
}

export async function listHostReviews(req: Request, res: Response) {
  const data = await service.listHostReviews(userId(req));
  return ok(res, data);
}

export async function getHostReviewDetail(req: Request, res: Response) {
  const data = await service.getHostReviewDetail(userId(req), Number(req.params.reviewId));
  return ok(res, data);
}

export async function replyToReview(req: Request, res: Response) {
  const data = await service.replyToReview(userId(req), Number(req.params.reviewId), req.body.hostAnswer);
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

/** What the guest would get back if they cancelled right now. */
export async function cancelQuote(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  return ok(res, await service.guestCancelQuote(req.user!.sub, id));
}
