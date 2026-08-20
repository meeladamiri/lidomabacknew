// src/modules/admin/catalogRouter.ts
import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { idParamSchema } from "./admin.schema";
import { ok } from "@/utils/response";
import { AnyZodObject } from "zod";

export interface CrudService {
  list: () => Promise<any> | any;
  create: (data: any) => Promise<any> | any;
  update: (id: number, data: any) => Promise<any> | any;
  remove: (id: number) => Promise<any> | any;
}

export function buildCatalogRouter(service: CrudService, schema: AnyZodObject) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const data = await service.list();
      return ok(res, data);
    })
  );

  router.post(
    "/",
    validate(schema),
    asyncHandler(async (req, res) => {
      const data = await service.create(req.body);
      return ok(res, data, 201);
    })
  );

  router.patch(
    "/:id",
    validate(idParamSchema),
    validate(schema),
    asyncHandler(async (req, res) => {
      const data = await service.update(Number(req.params.id), req.body);
      return ok(res, data);
    })
  );

  router.delete(
    "/:id",
    validate(idParamSchema),
    asyncHandler(async (req, res) => {
      const data = await service.remove(Number(req.params.id));
      return ok(res, data);
    })
  );

  return router;
}
