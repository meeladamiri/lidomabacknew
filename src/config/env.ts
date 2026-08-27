import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? "http://localhost:4000",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret"),
    accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
    refreshTtl: process.env.JWT_REFRESH_TTL ?? "30d",
  },

  otp: {
    ttlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 120),
    codeLength: Number(process.env.OTP_CODE_LENGTH ?? 5),
    smsApiKey: process.env.SMS_PROVIDER_API_KEY ?? "",
    smsSender: process.env.SMS_PROVIDER_SENDER ?? "",
  },

  adminBootstrap: {
    phone: process.env.ADMIN_BOOTSTRAP_PHONE ?? "09120000000",
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "ChangeMe123!",
  },

  // Shared cache. Unset locally — Liara's Redis is on a private network and a
  // laptop cannot reach it — in which case every cache call becomes a no-op
  // and reads go straight to the database. See lib/cache.ts.
  redis: {
    url: process.env.REDIS_URL ?? "",
  },

  // Object storage (Liara, S3-compatible). When unset, uploads fall back to
  // local disk (see middleware/upload.ts) — fine for dev, not for production.
  objectStorage: {
    endpoint: process.env.LIARA_ENDPOINT ?? "",
    bucket: process.env.LIARA_BUCKET ?? "",
    accessKey: process.env.LIARA_ACCESS_KEY ?? "",
    secretKey: process.env.LIARA_SECRET_KEY ?? "",
  },
} as const;

export const isProd = env.nodeEnv === "production";
