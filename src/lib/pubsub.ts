/**
 * Cross-instance fan-out for chat, plus presence.
 *
 * A message written on the instance serving the sender has to reach whichever
 * instance is holding the recipient's open SSE connection — which, behind a
 * load balancer, is usually not the same one. Redis pub/sub is the shortest
 * path to that, and Redis is already here for the cache.
 *
 * Everything degrades. With no Redis, publish() delivers to local subscribers
 * only and presence falls back to "is there an open connection on *this*
 * instance": correct for a single instance, which is how the app runs today,
 * and merely incomplete rather than broken if it ever scales out before this
 * is revisited.
 */

import type Redis from "ioredis";
import { createRedis } from "@/lib/cache";

/** One channel, filtered on arrival, rather than a channel per user.
 *
 * Subscribing per user means a SUBSCRIBE and an UNSUBSCRIBE on every page
 * open and close, and a subscription set that leaks whenever a connection
 * dies without unwinding. At this scale the cost of every instance seeing
 * every event is a JSON parse and a map lookup; the cost of the other design
 * is a class of bug. Worth revisiting if instance count or traffic changes
 * that arithmetic.
 */
const CHANNEL = "chat:events";

/** Presence keys outlive one heartbeat, so a slow tick is not "offline". */
const ONLINE_TTL_SECONDS = 90;

export interface ChatEvent {
  /** Who should receive it. */
  userId: number;
  type:
    | "message"
    | "conversation"
    | "read"
    | "typing"
    | "unread"
    | "message-deleted";
  payload: unknown;
}

type Handler = (event: ChatEvent) => void;

const handlers = new Set<Handler>();

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let started = false;

/**
 * Opens the pub/sub pair. Called once at boot; safe to call again.
 *
 * The subscriber gets no commandTimeout: it is meant to sit idle waiting for
 * traffic, and the cache's one-second bound would tear it down on a quiet
 * connection.
 */
export function initPubSub(): void {
  if (started) return;
  started = true;

  publisher = createRedis("chat-pub");
  subscriber = createRedis("chat-sub", {
    // A subscriber is meant to sit idle waiting for traffic. The cache's
    // one-second command bound would tear down a quiet connection.
    commandTimeout: undefined,
    maxRetriesPerRequest: null,
    // And unlike a cache read, SUBSCRIBE has to survive being issued before
    // the socket is up — it is setup, not a request on anyone's critical path.
    enableOfflineQueue: true,
  });

  if (!subscriber) return;

  // On every ready, not once at startup. A dropped connection comes back
  // with no subscriptions on it, and a subscriber that silently stopped
  // receiving looks exactly like a chat where nobody is talking.
  subscriber.on("ready", () => {
    subscriber?.subscribe(CHANNEL).catch(() => {
      /* createRedis already logged it; local delivery still stands */
    });
  });

  subscriber.on("message", (_channel: string, raw: string) => {
    let event: ChatEvent;
    try {
      event = JSON.parse(raw) as ChatEvent;
    } catch {
      return;
    }
    for (const handler of handlers) handler(event);
  });
}

/**
 * Sends an event to whichever instance is holding that user's connection.
 *
 * With Redis, the local instance receives its own publish back through the
 * subscription, so it is not delivered twice here. Without Redis, there is no
 * loop back and local handlers are called directly.
 */
export function publish(event: ChatEvent): void {
  if (publisher) {
    publisher.publish(CHANNEL, JSON.stringify(event)).catch(() => {
      // Redis went away mid-flight: fall back to this instance so the sender's
      // own tabs still update.
      for (const handler of handlers) handler(event);
    });
    return;
  }

  for (const handler of handlers) handler(event);
}

/** Registers a listener. Returns the unsubscribe. */
export function onChatEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Marks a user as connected, for the notification layer to check.
 *
 * Refreshed by the SSE heartbeat rather than set once, so a browser that dies
 * without closing cleanly stops looking online within the TTL instead of
 * suppressing that user's SMS forever.
 */
export async function markOnline(userId: number): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.set(`chat:online:${userId}`, "1", "EX", ONLINE_TTL_SECONDS);
  } catch {
    /* presence is an optimisation; a miss just means one more SMS */
  }
}

export async function isOnline(userId: number): Promise<boolean> {
  if (!publisher) return false;
  try {
    return (await publisher.exists(`chat:online:${userId}`)) === 1;
  } catch {
    // Unknown, so assume offline: a needless notification is a smaller
    // failure than a silent one.
    return false;
  }
}

/**
 * Rate limit shared across instances, used for the SMS throttle.
 *
 * Returns true the first time a key is seen in the window and false after,
 * via SET NX EX — one round trip, and atomic, so two instances handling two
 * messages at once cannot both decide they are the first.
 */
export async function takeToken(key: string, windowSeconds: number): Promise<boolean> {
  if (!publisher) return true;
  try {
    const set = await publisher.set(`chat:throttle:${key}`, "1", "EX", windowSeconds, "NX");
    return set === "OK";
  } catch {
    return true;
  }
}
