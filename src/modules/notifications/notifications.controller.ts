import type { Request, Response } from "express";
import * as service from "./notifications.service";
import { ok } from "@/utils/response";

export async function list(req: Request, res: Response) {
  const { archived, cursor, take } = req.query as unknown as {
    archived?: boolean;
    cursor?: number;
    take?: number;
  };
  return ok(res, await service.list(req.user!.sub, { archived, cursor, take }));
}

export async function unreadCount(req: Request, res: Response) {
  return ok(res, { count: await service.unreadCount(req.user!.sub) });
}

export async function markRead(req: Request, res: Response) {
  const { ids } = req.body as { ids?: number[] };
  return ok(res, { updated: await service.markRead(req.user!.sub, ids) });
}

export async function archive(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  const { archived } = req.body as { archived?: boolean };
  return ok(res, await service.archive(req.user!.sub, id, archived ?? true));
}

export async function archiveAll(req: Request, res: Response) {
  return ok(res, { updated: await service.archiveAll(req.user!.sub) });
}
