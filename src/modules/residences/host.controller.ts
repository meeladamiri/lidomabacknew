import { Request, Response } from "express";
import { ok, created } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { fileToUrl } from "@/middleware/upload";
import * as service from "./residences.service";

function hostId(req: Request): number {
  if (!req.user) throw AppError.unauthorized();
  return req.user.sub;
}

export async function list(req: Request, res: Response) {
  const data = await service.listHostResidences(hostId(req));
  return ok(res, data);
}

export async function getOne(req: Request, res: Response) {
  const data = await service.getHostResidenceFull(hostId(req), Number(req.params.id));
  return ok(res, data);
}

export async function create(req: Request, res: Response) {
  const data = await service.createResidence(hostId(req), req.body);
  return created(res, data);
}

export async function updateSpecs(req: Request, res: Response) {
  const data = await service.updateSpecs(hostId(req), Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateAmenities(req: Request, res: Response) {
  const data = await service.updateAmenities(hostId(req), Number(req.params.id), req.body.amenities);
  return ok(res, data);
}

export async function updateRules(req: Request, res: Response) {
  const data = await service.updateRules(hostId(req), Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updatePricing(req: Request, res: Response) {
  const data = await service.updatePricing(hostId(req), Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateCapacity(req: Request, res: Response) {
  const data = await service.updateCapacity(hostId(req), Number(req.params.id), req.body);
  return ok(res, data);
}

export async function changeState(req: Request, res: Response) {
  const data = await service.changeResidenceState(hostId(req), Number(req.params.id), req.body.action);
  return ok(res, data);
}

export async function addRoom(req: Request, res: Response) {
  const data = await service.addRoom(hostId(req), Number(req.params.id), req.body);
  return created(res, data);
}

export async function updateRoom(req: Request, res: Response) {
  const data = await service.updateRoom(hostId(req), Number(req.params.roomId), req.body);
  return ok(res, data);
}

export async function deleteRoom(req: Request, res: Response) {
  await service.deleteRoom(hostId(req), Number(req.params.roomId));
  return ok(res, { success: true });
}

export async function uploadImage(req: Request, res: Response) {
  if (!req.file) throw AppError.badRequest("فایل تصویر ارسال نشده است");
  const url = fileToUrl(req.file.filename);
  const data = await service.addImage(hostId(req), Number(req.params.id), url, req.body.title);
  return created(res, data);
}

export async function deleteImage(req: Request, res: Response) {
  await service.deleteImage(hostId(req), Number(req.params.id), Number(req.params.imageId));
  return ok(res, { success: true });
}

export async function reorderImages(req: Request, res: Response) {
  await service.reorderImages(hostId(req), Number(req.params.id), req.body.imageIds);
  return ok(res, { success: true });
}
