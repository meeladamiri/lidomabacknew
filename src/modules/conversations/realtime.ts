/**
 * The live channel, as server-sent events.
 *
 * Not WebSocket, and not socket.io. Sending a message is an ordinary POST, so
 * the only thing that needs pushing is the other direction, and `EventSource`
 * does that natively — no client library, no bytes added to a bundle four
 * sessions were spent shrinking, no upgrade handshake to get through Liara's
 * proxy, and reconnection already handled by the browser.
 *
 * Delivery across instances is Redis pub/sub (lib/pubsub.ts). With no Redis a
 * connection still receives everything that happens on its own instance, which
 * is correct for a single instance and merely incomplete beyond one.
 */

import { Request, Response } from "express";
import { markOnline, onChatEvent, type ChatEvent } from "@/lib/pubsub";

/** Under most proxy idle timeouts, and frequent enough to keep presence fresh. */
const HEARTBEAT_MS = 25_000;

export function streamHandler(req: Request, res: Response) {
  const userId = req.user!.sub;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Nginx (and Liara's proxy in front of it) buffers proxied responses by
  // default, which for a stream means events arrive in clumps or not at all.
  res.setHeader("X-Accel-Buffering", "no");
  // compression() is mounted globally and would sit on this forever waiting
  // for a stream that never ends. It skips a response whose encoding is
  // already decided.
  res.setHeader("Content-Encoding", "identity");
  res.flushHeaders();

  // Tells the browser how long to wait before reconnecting, and gives any
  // proxy in the path something to forward immediately.
  res.write("retry: 5000\n\n");

  const send = (event: ChatEvent) => {
    if (event.userId !== userId) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  };

  const unsubscribe = onChatEvent(send);
  void markOnline(userId);

  const heartbeat = setInterval(() => {
    // A comment line: valid SSE, ignored by EventSource, and enough to keep
    // the socket from being reaped. Doubles as the presence refresh, so a tab
    // that dies without closing cleanly stops looking online within the TTL
    // rather than suppressing that user's SMS forever.
    res.write(": ping\n\n");
    void markOnline(userId);
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on("close", close);
  res.on("close", close);
}
