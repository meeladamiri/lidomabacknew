import { Request, Response } from "express";
import { ok, created, paginated } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { fileToUrl } from "@/middleware/upload";
import * as service from "./admin.service";

function getOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value;
}

export async function dashboardStats(_req: Request, res: Response) {
  const data = await service.getDashboardStats();

  return ok(res, data);
}

export async function listUsers(req: Request, res: Response) {
  const result = await service.listUsers({
    page: getOptionalNumber(req.query.page),
    pageSize: getOptionalNumber(req.query.pageSize),
    q: getOptionalString(req.query.q),
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function getUser(req: Request, res: Response) {
  const data = await service.getUser(Number(req.params.id));

  return ok(res, data);
}

export async function updateUser(req: Request, res: Response) {
  const data = await service.updateUser(Number(req.params.id), req.body);

  return ok(res, data);
}

function getFilters(value: unknown): service.FilterCondition[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function residenceFilterFields(_req: Request, res: Response) {
  return ok(res, service.RESIDENCE_FILTER_FIELDS);
}

export async function listResidences(req: Request, res: Response) {
  const result = await service.listResidences({
    page: getOptionalNumber(req.query.page),
    pageSize: getOptionalNumber(req.query.pageSize),
    q: getOptionalString(req.query.q),
    state: getOptionalString(req.query.state),
    filters: getFilters(req.query.filters),
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function getResidence(req: Request, res: Response) {
  const data = await service.getResidence(Number(req.params.id));

  return ok(res, data);
}

export async function setResidenceState(req: Request, res: Response) {
  const data = await service.setResidenceState(
    Number(req.params.id),
    req.body.state
  );

  return ok(res, data);
}

export async function updateResidenceSpecs(req: Request, res: Response) {
  const data = await service.adminUpdateResidenceSpecs(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceAmenities(req: Request, res: Response) {
  const data = await service.adminUpdateAmenities(Number(req.params.id), req.body.amenities, req.body.other);
  return ok(res, data);
}

export async function updateResidenceRules(req: Request, res: Response) {
  const data = await service.adminUpdateRules(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidencePricing(req: Request, res: Response) {
  const data = await service.adminUpdatePricing(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceCapacity(req: Request, res: Response) {
  const data = await service.adminUpdateCapacity(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function addResidenceRoom(req: Request, res: Response) {
  const data = await service.adminAddRoom(Number(req.params.id), req.body);
  return created(res, data);
}

export async function replaceResidenceRooms(req: Request, res: Response) {
  const data = await service.adminReplaceRooms(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceRoom(req: Request, res: Response) {
  const data = await service.adminUpdateRoom(Number(req.params.roomId), req.body);
  return ok(res, data);
}

export async function deleteResidenceRoom(req: Request, res: Response) {
  await service.adminDeleteRoom(Number(req.params.roomId));
  return ok(res, { success: true });
}

export async function uploadResidenceImage(req: Request, res: Response) {
  if (!req.file) throw AppError.badRequest("فایل تصویر ارسال نشده است");
  const url = fileToUrl(req.file);
  const isMain = req.body.isMain === undefined ? undefined : req.body.isMain === "true";
  const data = await service.adminAddImage(Number(req.params.id), url, req.body.title, isMain);
  return created(res, data);
}

export async function deleteResidenceImage(req: Request, res: Response) {
  await service.adminDeleteImage(Number(req.params.id), Number(req.params.imageId));
  return ok(res, { success: true });
}

export async function reorderResidenceImages(req: Request, res: Response) {
  await service.adminReorderImages(Number(req.params.id), req.body.imageIds);
  return ok(res, { success: true });
}

export async function listReservations(req: Request, res: Response) {
  const result = await service.listReservations({
    page: getOptionalNumber(req.query.page),
    pageSize: getOptionalNumber(req.query.pageSize),
    state: getOptionalString(req.query.state),
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function getReservation(req: Request, res: Response) {
  const data = await service.getReservation(Number(req.params.id));

  return ok(res, data);
}

export async function listFilterPresets(req: Request, res: Response) {
  const data = await service.listFilterPresets(getOptionalString(req.query.entity));
  return ok(res, data);
}

export async function createFilterPreset(req: Request, res: Response) {
  const data = await service.createFilterPreset(req.body.name, req.body.entity, req.body.filters);
  return ok(res, data);
}

export async function deleteFilterPreset(req: Request, res: Response) {
  await service.deleteFilterPreset(Number(req.params.id));
  return ok(res, { success: true });
}

export async function updateReservation(req: Request, res: Response) {
  const data = await service.updateReservationByAdmin(
    Number(req.params.id),
    req.body.action,
    req.body.reason,
    req.body.desc
  );

  return ok(res, data);
}
