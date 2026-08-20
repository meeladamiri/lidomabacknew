import { Response } from "express";

export function ok(res: Response, data: unknown, statusCode = 200) {
  return res.status(statusCode).json({ status: "success", data });
}

export function created(res: Response, data: unknown) {
  return ok(res, data, 201);
}

export function paginated(
  res: Response,
  items: unknown[],
  meta: { page: number; pageSize: number; total: number }
) {
  return res.status(200).json({
    status: "success",
    data: items,
    meta: {
      ...meta,
      pageCount: Math.max(1, Math.ceil(meta.total / meta.pageSize)),
    },
  });
}
