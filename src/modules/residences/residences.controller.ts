import { Request, Response } from "express";
import { ok } from "@/utils/response";
import { cached, TTL } from "@/lib/cache";
import * as service from "./residences.service";
import { recordView } from "@/modules/admin/residenceStats.service";

/**
 * Crawlers, by the part of the user agent that names them.
 *
 * Not thorough, and not meant to be — it exists so a host does not open their
 * statistics and read Googlebot's crawl rate as interest in their listing.
 * Anything that gets past it is counted, which is the right way round: a
 * missed bot inflates a number, a wrongly-excluded person erases a real visit.
 */
const BOT = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i;

export async function getDetail(req: Request, res: Response) {
  const id = Number(req.params.id);
  const data = await cached(`residence:${id}`, TTL.residence, () =>
    service.getResidenceDetail(id)
  );

  // Outside the cache callback on purpose. Inside it, a view would only be
  // counted on a cache miss — which is to say the busiest listings, the ones
  // that stay warm, would report the fewest visits.
  const agent = req.headers["user-agent"] ?? "";
  if (!BOT.test(agent)) {
    const residenceId = (data as { residence?: { id?: number } })?.residence?.id;
    if (residenceId) recordView(residenceId);
  }

  return ok(res, data);
}

/** Cheap check for /rentals/<id>'s getServerSideProps — call before the full
 * detail fetch, so a deleted or deactivated listing's page never pays for
 * that heavier query only to throw it away and redirect anyway. */
export async function getRedirect(req: Request, res: Response) {
  const id = Number(req.params.id);
  const redirect = await service.getResidenceRedirect(id);
  return ok(res, { redirect });
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
