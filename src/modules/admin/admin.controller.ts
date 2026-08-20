import { Request, Response } from "express";
import { ok, paginated } from "@/utils/response";
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

export async function listResidences(req: Request, res: Response) {
  const result = await service.listResidences({
    page: getOptionalNumber(req.query.page),
    pageSize: getOptionalNumber(req.query.pageSize),
    q: getOptionalString(req.query.q),
    state: getOptionalString(req.query.state),
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
