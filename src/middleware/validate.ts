import { NextFunction, Request, Response } from "express";
import { AnyZodObject } from "zod";

/**
 * Validates req.{body,query,params} against a zod schema shaped as
 * z.object({ body: ..., query: ..., params: ... }) (any subset).
 * Replaces req.body/query/params with the parsed (and coerced) values.
 */
export function validate(schema: AnyZodObject) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed.body) req.body = parsed.body;
      if (parsed.query) req.query = parsed.query;
      if (parsed.params) req.params = parsed.params;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
