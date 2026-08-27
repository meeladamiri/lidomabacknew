import { createHash } from "node:crypto";
import { Request, Response } from "express";
import { ok, paginated } from "@/utils/response";
import { cached, TTL } from "@/lib/cache";
import * as searchService from "./search.service";

/**
 * A stable key for a search body.
 *
 * The same filters can arrive with their keys in any order and with undefined
 * entries present or absent, so the raw JSON is not usable as a key — it would
 * split one popular query across a dozen cache entries. Sorting the keys and
 * dropping the empties collapses them onto one.
 */
function bodyKey(body: unknown): string {
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          const v = normalize(value[k]);
          if (v !== undefined && v !== null && v !== "") acc[k] = v;
          return acc;
        }, {});
    }
    return value;
  };
  return createHash("sha1").update(JSON.stringify(normalize(body))).digest("hex").slice(0, 16);
}

/**
 * Slugs and typed queries are short in every real case. Anything longer is
 * not a destination anyone is looking for, so it is served but not stored.
 */
function keyFor(prefix: string, value: string, max = 48): string | null {
  return value.length <= max ? `${prefix}${value}` : null;
}

export async function popularDestinations(_req: Request, res: Response) {
  const data = await cached("search:popular", TTL.taxonomy, () =>
    searchService.getPopularDestinations()
  );
  return ok(res, data);
}

export async function searchCities(req: Request, res: Response) {
  const { q } = req.query as { q: string };
  // The suggestion box fires this on every keystroke, and the same prefixes
  // recur across every visitor typing the same city name.
  const data = await cached(keyFor("search:cities:", q, 24), TTL.taxonomy, () =>
    searchService.searchCitiesAndProvinces(q)
  );
  return ok(res, data);
}

export async function searchPageData(req: Request, res: Response) {
  const { slug, tags } = req.query as { slug: string; tags?: string };
  const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const data = await cached(
    keyFor("search:page:", `${slug}:${(tagList ?? []).slice().sort().join(",")}`),
    TTL.searchPage,
    () => searchService.getSearchPageData(slug, tagList)
  );
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
  const data = await cached("search:provinces", TTL.taxonomy, () =>
    searchService.getProvincesAndCities()
  );
  return ok(res, data);
}

export async function searchResidences(req: Request, res: Response) {
  // Short TTL by design: filter and date combinations are near-unbounded, so
  // this is here to absorb the repeats — a shared link, a reader paging back
  // and forth — not to hold a long tail of one-off queries in memory.
  const result = await cached(`search:res:${bodyKey(req.body)}`, TTL.searchResults, () =>
    searchService.searchResidences(req.body)
  );
  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}
