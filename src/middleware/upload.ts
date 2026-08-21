import multer from "multer";
import multerS3 from "multer-s3";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { env } from "@/config/env";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

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

export { UPLOAD_ROOT };
