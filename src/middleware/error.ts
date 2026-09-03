import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
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

/** fs/S3 codes that mean "the file could not be written", not "bad input". */
const STORAGE_CODES = new Set(["EROFS", "EACCES", "EPERM", "ENOSPC", "ENOENT", "EDQUOT"]);

function isStorageError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("storageErrors" in err) return true;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && STORAGE_CODES.has(code);
}

function storageUnavailable(res: Response, err: unknown) {
  // eslint-disable-next-line no-console
  console.error("[upload] storage failure", err);
  return res.status(503).json({
    status: "error",
    code: "STORAGE_UNAVAILABLE",
    message: "ذخیره‌سازی فایل در سرور ممکن نشد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.",
  });
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

  /**
   * Uploads.
   *
   * Multer reports both its own limits and whatever the storage layer threw,
   * and every one of them used to land in the 500 branch below — so a photo
   * over the size limit, a wrong field name and a read-only filesystem were
   * all «خطای داخلی سرور». They are three different things and only one of
   * them is the server being broken.
   */
  if (err instanceof MulterError) {
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE: "حجم فایل بیش از حد مجاز است (حداکثر ۱۰ مگابایت).",
      LIMIT_FILE_COUNT: "تعداد فایل‌های ارسالی بیش از حد مجاز است.",
      LIMIT_UNEXPECTED_FILE: "فیلد فایل ارسالی معتبر نیست.",
      LIMIT_PART_COUNT: "درخواست ارسالی بیش از حد بزرگ است.",
    };
    const known = messages[err.code];
    if (known) {
      return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        status: "error",
        code: err.code,
        message: known,
      });
    }
    return storageUnavailable(res, err);
  }

  /**
   * The storage layer failing underneath multer.
   *
   * Not a MulterError: multer hands the original error along and only tacks
   * `storageErrors` onto it, so what arrives here for a read-only filesystem
   * is a plain fs Error carrying `code: "EROFS"`. That has a string `code`,
   * which is exactly what the Prisma check below tests for — so it slipped
   * past every branch and became a 500 with no field, no cause and no hint.
   */
  if (isStorageError(err)) return storageUnavailable(res, err);

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
