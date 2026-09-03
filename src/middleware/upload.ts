import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { env } from "@/config/env";
import { AppError } from "@/lib/errors";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

/**
 * Whether local disk is actually usable.
 *
 * On Liara — and on any container built from a read-only image — /app is
 * read-only. `mkdirSync` succeeds anyway, because `uploads/` ships inside the
 * image (it carries `sample.jpg`), so the only thing that ever failed was the
 * write itself: EROFS raised inside multer, reaching the error handler as an
 * object it did not recognise and going out as a bare 500 «خطای داخلی سرور».
 * Every upload in production failed that way and nothing said why.
 *
 * So probe once, at boot, and let the guard below answer before a host has
 * spent a minute sending a photo nowhere.
 */
const diskWritable = (() => {
  try {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    const probe = path.join(UPLOAD_ROOT, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

function generateFilename(originalname: string): string {
  const ext = path.extname(originalname) || "";
  return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
}

const useObjectStorage = !!(
  env.objectStorage.endpoint &&
  env.objectStorage.bucket &&
  env.objectStorage.accessKey &&
  env.objectStorage.secretKey
);

const s3Client = useObjectStorage
  ? new S3Client({
      endpoint: `https://${env.objectStorage.endpoint}`,
      region: "us-east-1", // required by the SDK; Liara ignores it
      credentials: {
        accessKeyId: env.objectStorage.accessKey,
        secretAccessKey: env.objectStorage.secretKey,
      },
      forcePathStyle: false, // Liara serves buckets as <bucket>.<endpoint>/<key>
    })
  : undefined;

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => cb(null, generateFilename(file.originalname)),
});

// NOTE: local disk storage is fine for development, but doesn't survive a
// redeploy/restart without a persistent volume and doesn't work across
// multiple app instances. Set the LIARA_* env vars (see .env.example) to
// switch uploads to Liara Object Storage (S3-compatible) instead — the rest
// of the app only relies on receiving a public `url` back from `fileToUrl`.
const s3Storage = s3Client
  ? multerS3({
      s3: s3Client,
      bucket: env.objectStorage.bucket,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (_req, file, cb) => cb(null, generateFilename(file.originalname)),
    })
  : undefined;

export const upload = multer({
  storage: s3Storage ?? diskStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/** True when uploads go to object storage rather than the container disk. */
export const usingObjectStorage = useObjectStorage;

/**
 * Refuses an upload the server has nowhere to put, before reading the body.
 *
 * Declared in front of every `upload.*` middleware. Without it the host waits
 * for the whole file to travel and is then told «خطای داخلی سرور» — the wait
 * and no explanation.
 */
export function requireUploadStorage(_req: Request, _res: Response, next: NextFunction) {
  if (useObjectStorage || diskWritable) return next();
  return next(
    AppError.internal(
      "سرویس ذخیره‌سازی فایل پیکربندی نشده است. لطفاً با پشتیبانی تماس بگیرید.",
      "STORAGE_UNAVAILABLE"
    )
  );
}

if (!useObjectStorage) {
  // eslint-disable-next-line no-console
  console.warn(
    diskWritable
      ? "[upload] object storage not configured — files go to local disk and will not survive a restart. Set LIARA_ENDPOINT / LIARA_BUCKET / LIARA_ACCESS_KEY / LIARA_SECRET_KEY."
      : "[upload] object storage not configured AND the local disk is read-only — every upload will be refused. Set LIARA_ENDPOINT / LIARA_BUCKET / LIARA_ACCESS_KEY / LIARA_SECRET_KEY."
  );
}

export function fileToUrl(file: Express.Multer.File): string {
  const s3Location = (file as Express.MulterS3.File).location;
  if (useObjectStorage && s3Location) {
    return s3Location;
  }
  return `/uploads/${file.filename}`;
}

// Best-effort cleanup — swallows errors so a storage hiccup never blocks the
// (already-committed) DB delete that triggered it. No-op for local disk URLs
// or when object storage isn't configured.
export async function deleteStoredFile(url: string | null | undefined): Promise<void> {
  if (!s3Client || !url) return;
  const prefix = `https://${env.objectStorage.bucket}.${env.objectStorage.endpoint}/`;
  if (!url.startsWith(prefix)) return;
  const key = url.slice(prefix.length);
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: env.objectStorage.bucket, Key: key }));
  } catch {
    // ignore — orphaned storage objects are a cheap tradeoff for never
    // failing a delete request because of a storage-side issue
  }
}

export { UPLOAD_ROOT, diskWritable };
