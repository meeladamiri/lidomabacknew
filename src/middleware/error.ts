import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { isProd } from "@/config/env";

type PrismaErrorLike = {
  code?: unknown;
  meta?: unknown;
};

function isPrismaError(err: unknown): err is PrismaErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

export function notFoundHandler(req: Request, res: Response) {
  return res.status(404).json({
    status: "error",
    code: "ROUTE_NOT_FOUND",
    message: `مسیر ${req.method} ${req.originalUrl} یافت نشد`,
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: "error",
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  if (err instanceof ZodError) {
    /**
     * Which field, not just "something".
     *
     * `flatten()` keys by `issue.path[0]`, and every schema here is shaped
     * as { body, params, query } — so a bad `totalArea` came back as
     * `fieldErrors: { body: [...] }`. The response said «ورودی نامعتبر است»
     * and named nothing, on requests carrying fifteen fields. That is a large
     * part of why the wizard's specs step stayed broken: the failure was
     * visible on every attempt and pointed nowhere.
     *
     * Dropping the section prefix gives the caller a map it can put next to
     * the offending input.
     */
    const fieldErrors: Record<string, string[]> = {};
    const formErrors: string[] = [];
    for (const issue of err.issues) {
      const field = issue.path.slice(1).join(".");
      if (!field) formErrors.push(issue.message);
      else (fieldErrors[field] ||= []).push(issue.message);
    }
    return res.status(400).json({
      status: "error",
      code: "VALIDATION_ERROR",
      message: "ورودی نامعتبر است",
      details: { fieldErrors, formErrors },
    });
  }

  // بررسی خطاهای Prisma بدون import کردن کلاینت تولیدشده
  if (isPrismaError(err)) {
    if (err.code === "P2002") {
      return res.status(409).json({
        status: "error",
        code: "UNIQUE_CONSTRAINT",
        message: "این مقدار قبلاً ثبت شده است",
        details: err.meta,
      });
    }

    if (err.code === "P2025") {
      return res.status(404).json({
        status: "error",
        code: "NOT_FOUND",
        message: "مورد یافت نشد",
      });
    }
  }

  // eslint-disable-next-line no-console
  console.error(err);

  return res.status(500).json({
    status: "error",
    code: "INTERNAL_ERROR",
    message: "خطای داخلی سرور",
    stack: !isProd && err instanceof Error ? err.stack : undefined,
  });
}
