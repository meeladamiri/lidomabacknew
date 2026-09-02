import { Request, Response } from "express";
import { ok, created } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { fileToUrl } from "@/middleware/upload";
import * as service from "./residences.service";
import * as wizard from "./wizard.service";
import {
  getClassification,
  getClassificationOptions,
  setClassification,
  type ClassificationKey,
} from "@/modules/admin/residenceClassification.service";

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

export async function stats(req: Request, res: Response) {
  const residenceId = req.query.residenceId ? Number(req.query.residenceId) : undefined;
  const data = await service.getHostResidenceStats(hostId(req), residenceId);
  return ok(res, data);
}

export async function wizardContent(_req: Request, res: Response) {
  return ok(res, await wizard.getWizardContent());
}

/**
 * «نوع اقامتگاه» و «منطقه اقامتگاه» — the taxonomies the SEO tag pages match on.
 *
 * The panel has had these for a while; the wizard has not, and wrote its
 * answer to `residence.region` instead — a column nothing reads. So every
 * listing a host created was missing from the tag pages that would have shown
 * it. Same service the panel uses, so the two cannot drift apart.
 */
export async function classificationOptions(_req: Request, res: Response) {
  return ok(res, await getClassificationOptions());
}

export async function residenceClassification(req: Request, res: Response) {
  await service.getHostResidenceFull(hostId(req), Number(req.params.id)); // ownership
  return ok(res, await getClassification(Number(req.params.id)));
}

export async function saveClassification(req: Request, res: Response) {
  const id = Number(req.params.id);
  await service.getHostResidenceFull(hostId(req), id); // ownership
  const body = req.body as { key: ClassificationKey; values: string[] };
  return ok(
    res,
    await setClassification({ residenceId: id, ...body, actorId: hostId(req) })
  );
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
  const data = await service.updateAmenities(
    hostId(req),
    Number(req.params.id),
    req.body.amenities,
    req.body.other,
    req.body.step
  );
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
  const data = await service.changeResidenceState(
    hostId(req),
    Number(req.params.id),
    req.body.action,
    req.body.step
  );
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

export async function replaceRooms(req: Request, res: Response) {
  const data = await service.replaceRooms(hostId(req), Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateDocuments(req: Request, res: Response) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const patch: { hostNationalCardUrl?: string; documentUrl?: string; ownerNationalCardUrl?: string } = {};
  if (files?.hostNationalCard?.[0]) patch.hostNationalCardUrl = fileToUrl(files.hostNationalCard[0]);
  if (files?.document?.[0]) patch.documentUrl = fileToUrl(files.document[0]);
  if (files?.ownerNationalCard?.[0]) patch.ownerNationalCardUrl = fileToUrl(files.ownerNationalCard[0]);
  const data = await service.updateDocuments(hostId(req), Number(req.params.id), patch);
  return ok(res, data);
}

export async function uploadImage(req: Request, res: Response) {
  if (!req.file) throw AppError.badRequest("فایل تصویر ارسال نشده است");
  const url = fileToUrl(req.file);
  const isMain = req.body.isMain === undefined ? undefined : req.body.isMain === "true";
  const data = await service.addImage(hostId(req), Number(req.params.id), url, req.body.title, isMain);
  return created(res, data);
}

/**
 * Editing one photo — in practice, choosing which one is the cover.
 *
 * The service and its schema already existed for the admin panel; the host
 * had no route to them, so the wizard could only set a main image at upload
 * time. Picking a different cover afterwards meant deleting and re-uploading.
 */
export async function updateImage(req: Request, res: Response) {
  const data = await service.updateImage(
    hostId(req),
    Number(req.params.id),
    Number(req.params.imageId),
    req.body
  );
  return ok(res, data);
}

export async function deleteImage(req: Request, res: Response) {
  await service.deleteImage(hostId(req), Number(req.params.id), Number(req.params.imageId));
  return ok(res, { success: true });
}

export async function reorderImages(req: Request, res: Response) {
  await service.reorderImages(hostId(req), Number(req.params.id), req.body.imageIds);
  return ok(res, { success: true });
}
