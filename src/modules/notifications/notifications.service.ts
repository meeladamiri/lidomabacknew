import { Prisma, type NotificationKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

const DEFAULT_TAKE = 20;
const MAX_TAKE = 50;

export interface NotificationInput {
  userId: number;
  kind: NotificationKind;
  title: string;
  body: string;
  linkUrl?: string | null;
  entityType?: string | null;
  entityId?: number | null;
}

/**
 * Writes one notification, or does nothing if that exact event was already
 * recorded for that user.
 *
 * Idempotency is the database's, via the unique index on
 * (userId, kind, entityType, entityId) — not a read-then-write, which two
 * concurrent requests would both pass. A reservation approved twice (a retry,
 * a double-click in the panel) produces one line.
 *
 * Returns the row when it created one and null when it was a duplicate, so
 * callers can decide whether to push anything down the wire.
 */
export async function record(input: NotificationInput) {
  try {
    return await prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        linkUrl: input.linkUrl ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });
  } catch (error) {
    // P2002: the unique index caught a duplicate. That is the design working,
    // not a failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return null;
    }
    throw error;
  }
}

export async function list(
  userId: number,
  opts: { archived?: boolean; cursor?: number; take?: number } = {}
) {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), MAX_TAKE);
  const archived = opts.archived ?? false;

  const rows = await prisma.notification.findMany({
    where: {
      userId,
      archivedAt: archived ? { not: null } : null,
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    // One extra row answers "is there another page" without a second count
    // query, which on this table would scan everything the user has ever had.
    take: take + 1,
  });

  const items = rows.slice(0, take);
  return {
    items: items.map(toRow),
    next_cursor: rows.length > take ? items[items.length - 1]!.id : null,
  };
}

/**
 * The header badge, run on every page load, so it is a covered count rather
 * than a fetch — the index on (user_id, archived_at, id) carries it.
 */
export async function unreadCount(userId: number): Promise<number> {
  return prisma.notification.count({
    where: { userId, archivedAt: null, readAt: null },
  });
}

/** Marks everything unread as read, or just the ids given. */
export async function markRead(userId: number, ids?: number[]): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
      ...(ids?.length ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function archive(userId: number, id: number, archived = true) {
  // Scoped by userId in the same statement rather than fetch-then-check, so
  // one user cannot archive another's row even for an instant.
  const result = await prisma.notification.updateMany({
    where: { id, userId },
    data: { archivedAt: archived ? new Date() : null },
  });

  if (result.count === 0) throw AppError.notFound("اعلان پیدا نشد");
  return { id, archived };
}

export async function archiveAll(userId: number): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  return result.count;
}

function toRow(n: {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  linkUrl: string | null;
  entityType: string | null;
  entityId: number | null;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link_url: n.linkUrl,
    entity_type: n.entityType,
    entity_id: n.entityId,
    is_read: n.readAt !== null,
    is_archived: n.archivedAt !== null,
    created_at: n.createdAt.toISOString(),
  };
}
