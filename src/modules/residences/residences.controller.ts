import { Request, Response } from "express";
import { ok } from "@/utils/response";
import { cached, TTL } from "@/lib/cache";
import * as service from "./residences.service";

export async function getDetail(req: Request, res: Response) {
  const id = Number(req.params.id);
  const data = await cached(`residence:${id}`, TTL.residence, () =>
    service.getResidenceDetail(id)
  );
  return ok(res, data);
}

export async function hostProfile(req: Request, res: Response) {
  const hostId = Number(req.params.hostId);
  const data = await cached(`residence:host:${hostId}`, TTL.residence, () =>
    service.getHostProfile(hostId)
  );
  return ok(res, data);
}

export async function amenityCatalog(_req: Request, res: Response) {
  const data = await cached("catalog:amenities", TTL.catalog, () => service.getAmenityCatalog());
  return ok(res, data);
}

export async function ruleCatalog(_req: Request, res: Response) {
  const data = await cached("catalog:rules", TTL.catalog, () => service.getRuleCatalog());
  return ok(res, data);
}
