import dotenv from "dotenv";

dotenv.config();

/**
 * Strips one matching pair of surrounding quotes, the way dotenv already does
 * for values in a .env file.
 *
 * Hosting panels do not. A value typed as "15m" in Liara's panel arrives as a
 * five-character string with the quote marks still in it, and the code that
 * consumes it has no way to tell that from a deliberate value. This has now
 * cost two separate outages:
 *
 *   DATABASE_URL   quoted  ->  the URL must start with the protocol postgresql://
 *   JWT_ACCESS_TTL quoted  ->  "expiresIn" should be a number of seconds or
 *                              string representing a timespan
 *
 * The second one was the worse of the two. Nothing was wrong with the login
 * itself — the password verified, the user was found, and it failed on the very
 * last step, signing the token. So every account got a 500 on a correct
 * password, and the panel looked right to anybody reading it.
 *
 * Doing this at the edge, once, is what makes the rest of the file able to
 * trust its own values. It normalises rather than rejects, because a deploy
 * that boots with a warning beats one that refuses to start over a quote mark.
 */
const unquoted = new Set<string>();

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  const isWrapped =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));

  if (!isWrapped) return raw;

  unquoted.add(name);
  return trimmed.slice(1, -1);
}

function required(name: string, fallback?: string): string {
  const value = readEnv(name) ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Says so on boot, loudly enough to find but not so loud it stops a deploy.
 * Silently correcting a misconfiguration and never mentioning it is how the
 * same mistake gets made again on the next service.
 */
export function reportQuotedEnv(): void {
  if (unquoted.size === 0) return;
  console.warn(
    `[env] Stripped surrounding quotes from: ${[...unquoted].sort().join(", ")}. ` +
      `Panel values are literal — remove the quote marks there.`
  );
}

export const env = {
  nodeEnv: readEnv("NODE_ENV") ?? "development",
  port: Number(readEnv("PORT") ?? 4000),
  appUrl: readEnv("APP_URL") ?? "http://localhost:4000",
  corsOrigins: (readEnv("CORS_ORIGINS") ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret"),
    accessTtl: readEnv("JWT_ACCESS_TTL") ?? "15m",
    refreshTtl: readEnv("JWT_REFRESH_TTL") ?? "30d",
  },

  otp: {
    ttlSeconds: Number(readEnv("OTP_TTL_SECONDS") ?? 120),
    codeLength: Number(readEnv("OTP_CODE_LENGTH") ?? 5),
    smsApiKey: readEnv("SMS_PROVIDER_API_KEY") ?? "",
    smsSender: readEnv("SMS_PROVIDER_SENDER") ?? "",
  },

  adminBootstrap: {
    phone: readEnv("ADMIN_BOOTSTRAP_PHONE") ?? "09120000000",
    password: readEnv("ADMIN_BOOTSTRAP_PASSWORD") ?? "ChangeMe123!",
  },

  // Shared cache. Unset locally — Liara's Redis is on a private network and a
  // laptop cannot reach it — in which case every cache call becomes a no-op
  // and reads go straight to the database. See lib/cache.ts.
  redis: {
    url: readEnv("REDIS_URL") ?? "",
  },

  // Background jobs (see lib/scheduler.ts). On by default: the jobs it runs
  // are things the site is wrong without — a host whose money is never
  // released is not a degraded feature, it is an unpaid host. Set to "false"
  // on any instance that should serve traffic only.
  scheduler: {
    enabled: (readEnv("SCHEDULER_ENABLED") ?? "true").toLowerCase() !== "false",
    /** How often the maturity sweep runs, in minutes. */
    releaseEveryMinutes: Number(readEnv("SCHEDULER_RELEASE_MINUTES") ?? 60) || 60,
    /** How often overdue bookings are expired. Deadlines are minutes, not days. */
    expireEveryMinutes: Number(readEnv("SCHEDULER_EXPIRE_MINUTES") ?? 5) || 5,
  },

  // Object storage (Liara, S3-compatible). When unset, uploads fall back to
  // local disk (see middleware/upload.ts) — fine for dev, not for production.
  objectStorage: {
    endpoint: readEnv("LIARA_ENDPOINT") ?? "",
    bucket: readEnv("LIARA_BUCKET") ?? "",
    accessKey: readEnv("LIARA_ACCESS_KEY") ?? "",
    secretKey: readEnv("LIARA_SECRET_KEY") ?? "",
  },
} as const;

export const isProd = env.nodeEnv === "production";
