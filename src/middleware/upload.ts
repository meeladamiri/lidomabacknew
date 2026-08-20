import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, name);
  },
});

// NOTE: local disk storage is fine for development. For production, swap
// this storage engine for an S3-compatible (e.g. Liara Object Storage,
// Arvan, AWS S3) multer-storage adapter — the rest of the app only relies
// on receiving a public `url` back from `fileToUrl` below.
export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export function fileToUrl(filename: string): string {
  return `/uploads/${filename}`;
}

export { UPLOAD_ROOT };
