import { Request, Response } from "express";
import { ok, paginated } from "@/utils/response";
import * as searchService from "./search.service";

export async function popularDestinations(_req: Request, res: Response) {
  const data = await searchService.getPopularDestinations();
  return ok(res, data);
}

export async function searchCities(req: Request, res: Response) {
  const { q } = req.query as { q: string };
  const data = await searchService.searchCitiesAndProvinces(q);
  return ok(res, data);
}

export async function searchResidences(req: Request, res: Response) {
  const result = await searchService.searchResidences(req.body);
  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}
