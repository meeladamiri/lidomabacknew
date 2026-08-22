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

export async function searchPageData(req: Request, res: Response) {
  const { slug } = req.query as { slug: string };
  const data = await searchService.getSearchPageData(slug);
  return ok(res, data);
}

export async function legacyImage(req: Request, res: Response) {
  const { model, id } = req.query as { model: string; id: string };
  const target = await searchService.resolveLegacyImage(model, Number(id));
  return ok(res, { target });
}

export async function legacyRedirect(req: Request, res: Response) {
  const { path } = req.query as { path: string };
  const target = await searchService.resolveLegacyRedirect(path);
  return ok(res, { target });
}

export async function provincesAndCities(_req: Request, res: Response) {
  const data = await searchService.getProvincesAndCities();
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
