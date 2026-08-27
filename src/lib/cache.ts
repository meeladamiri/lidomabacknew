/**
 * Shared read-through cache, backed by Redis.
 *
 * Two things the per-process caches this replaces could not do: survive a
 * restart or a deploy, and be shared between instances. With more than one
 * container behind the load balancer, a module-level `let cache` means each
 * one warms separately and an admin edit clears only the instance that
 * happened to serve the write.
 *
 * The cache is optional on purpose. `REDIS_URL` is unset in local development
 * — Liara's Redis lives on a private network and is not reachable from a
 * laptop — so every call here has to work with no Redis at all, and a Redis
 * that goes away mid-flight must degrade to a plain database read rather than
 * take the site down with it. Nothing in this file ever throws.
 */

import Redis from "ioredis";
import { env } from "@/config/env";

// One prefix for everything this app writes, so a Redis shared with anything
// else stays legible and `dropPrefix` can never walk another app's keys.
const PREFIX = "lido:";

let client: Redis | null = null;
let attempted = false;
let errorLogged = false;

function connect(): Redis | null {
  if (!env.redis.url) return null;
  if (attempted) return client;
  attempted = true;

  client = new Redis(env.redis.url, {
    // A cache must never be the reason a request is slow. With the offline
    // queue on (the default), commands issued while the connection is down
    // sit in memory until it returns — so an unreachable Redis would hang
    // every request instead of quietly missing. Failing fast puts us straight
    // on the loader path.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    // Bounds the worst case: a Redis that accepts the connection but answers
    // slowly must still lose to the query it was meant to save.
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 500, 30_000),
  });

  // ioredis emits 'error' on every failed reconnect. Unhandled, that is an
  // uncaught exception; logged in full, it is a wall of identical lines. Say
  // it once per outage instead.
  client.on("error", (err: Error) => {
    if (errorLogged) return;
    errorLogged = true;
    console.warn(`[cache] redis unavailable, serving from the database: ${err.message}`);
  });

  client.on("ready", () => {
    if (errorLogged) console.info("[cache] redis reconnected");
    errorLogged = false;
  });

  return client;
}

/**
 * Misses that arrive together share one loader.
 *
 * Without this, the moment a hot key expires every concurrent request for it
 * runs the same query — the home bundle, say, or a popular city's search page.
 * That is exactly when the database is least able to absorb it.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * @param key  `null` bypasses the cache entirely and just runs the loader.
 *
 * Cache keys are built from request input — a slug, a query string, a sitemap
 * filename — so anything that can be typed can mint a key. A caller that
 * cannot vouch for its input passes null for the shapes it does not recognise,
 * which keeps a crawler walking nonsense URLs from filling the keyspace with
 * entries nobody will ever read again. That matters most where the cached
 * answer is a 404, which is cheap to mint and long-lived.
 */
export async function cached<T>(
  key: string | null,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  if (key === null) return loader();

  const redis = connect();
  const full = PREFIX + key;

  if (redis) {
    try {
      const hit = await redis.get(full);
      // A miss is `null` from Redis; a cached JSON `null` comes back as the
      // string "null", so the two stay distinguishable.
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {
      /* unreachable or slow — fall through to the loader */
    }
  }

  const running = inflight.get(full);
  if (running) return running as Promise<T>;

  const run = (async () => {
    const value = await loader();
    if (redis && value !== undefined) {
      try {
        await redis.set(full, JSON.stringify(value), "EX", ttlSeconds);
      } catch {
        /* the read already succeeded; a failed write is not worth an error */
      }
    }
    return value;
  })();

  inflight.set(full, run);
  try {
    return await run;
  } finally {
    inflight.delete(full);
  }
}

/** Forget specific keys. Safe to call when Redis is absent. */
export async function dropKeys(...keys: string[]): Promise<void> {
  const redis = connect();
  if (!redis || keys.length === 0) return;
  try {
    await redis.unlink(...keys.map((k) => PREFIX + k));
  } catch {
    /* the entries expire on their own */
  }
}

/**
 * Forget everything under a prefix.
 *
 * SCAN rather than KEYS: KEYS blocks the server for the length of the
 * keyspace, and this runs on an admin write while readers are being served.
 */
export async function dropPrefix(prefix: string): Promise<void> {
  const redis = connect();
  if (!redis) return;

  try {
    const match = `${PREFIX}${prefix}*`;
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", match, "COUNT", 200);
      cursor = next;
      if (batch.length) await redis.unlink(...batch);
    } while (cursor !== "0");
  } catch {
    /* the entries expire on their own */
  }
}

/**
 * Everything an admin edit can invalidate.
 *
 * Deliberately broad. Working out which of the public caches a given write
 * actually touches means keeping that map correct across every future admin
 * endpoint, and the cost of being wrong (serving a stale page for the rest of
 * the TTL) is worse than the cost of being blunt (a handful of queries to
 * rebuild caches that admin writes are far too rare to keep cold).
 */
export async function dropPublicCaches(): Promise<void> {
  await Promise.all([
    dropPrefix("home:"),
    dropPrefix("search:"),
    dropPrefix("residence:"),
    dropPrefix("catalog:"),
    dropPrefix("sitemap:"),
  ]);
}

/**
 * Opens the connection at boot rather than on the first cache read.
 *
 * connect() is lazy, and with the offline queue disabled a command issued
 * before the socket is ready fails straight through to the loader — so a lazy
 * first touch costs a guaranteed miss *and* a dropped write, and the key stays
 * cold until someone asks a second time. Connecting at startup also puts a
 * misconfigured REDIS_URL in the boot log instead of leaving the cache
 * silently doing nothing in production.
 */
export function initCache(): void {
  connect();
}

/** For /health — reports whether the cache is off, connecting, or serving. */
export function cacheStatus(): { enabled: boolean; state: string } {
  if (!env.redis.url) return { enabled: false, state: "disabled" };
  return { enabled: true, state: client?.status ?? "idle" };
}

/** TTLs in one place, so the trade-off per surface is visible at a glance. */
export const TTL = {
  /** Curated, admin-edited, and invalidated explicitly on write. */
  home: 300,
  /** Counts and starting price per city — moves only as listings change. */
  searchPage: 300,
  /** Filter/date combinations. High cardinality, so kept deliberately short. */
  searchResults: 60,
  /** A listing's own page. */
  residence: 300,
  /** Cities, provinces, popular destinations — near-static taxonomy. */
  taxonomy: 900,
  /** Amenity and rule catalogues — changed by hand, almost never. */
  catalog: 3600,
  /** Rendered sitemap XML; crawlers hit these in bursts. */
  sitemap: 1800,
} as const;
