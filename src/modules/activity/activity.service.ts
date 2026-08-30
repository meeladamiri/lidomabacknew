import { Prisma, type ActivityKind, type CallDirection, type CallParty } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * The activity and communication log.
 *
 * One append-only table behind one timeline. A phone call, a status change and
 * a voucher that went out are the same question asked once — "what has
 * happened to this booking" — so they are one list, sorted by time, rather
 * than three panels the reader has to interleave themselves.
 *
 * ## How it stays out of the business logic
 *
 * Nothing in `reservations.service` knows this module exists. Two rules keep
 * it that way:
 *
 *   1. **Writes are fire-and-forget** (`record`), like the notification and
 *      chat hooks already in this codebase. A log line that failed is a bug to
 *      fix; it is never a reason for a booking to fail.
 *   2. **Automatic entries are produced by `diffAndLog`**, which takes the row
 *      before and the row after and works out what changed. Callers hand it
 *      two objects instead of remembering to log each field they touched —
 *      which is the version that goes stale the first time someone adds a
 *      column.
 *
 * Rows are immutable, enforced by a trigger in the migration rather than by
 * this file not offering an update.
 */

const fa = (n: number) => n.toLocaleString("fa-IR");

export interface RecordInput {
  kind: ActivityKind;
  summary: string;
  reservationId?: number | null;
  userId?: number | null;
  residenceId?: number | null;
  callDirection?: CallDirection | null;
  callParty?: CallParty | null;
  callOutcome?: string | null;
  details?: Prisma.InputJsonValue | null;
  actorId?: number | null;
  actorName?: string | null;
  source?: string;
}

/**
 * Writes a line. Awaited by callers who want the row; safe to `void`.
 *
 * Resolves the actor's name when given only an id, so no call site can forget
 * to and leave a row that cannot say who wrote it.
 */
export async function record(input: RecordInput) {
  let actorName = input.actorName ?? null;
  if (!actorName && input.actorId) {
    const actor = await prisma.user.findUnique({
      where: { id: input.actorId },
      select: { name: true, phone: true },
    });
    actorName = actor?.name || actor?.phone || `ادمین #${input.actorId}`;
  }

  return prisma.activityLog.create({
    data: {
      kind: input.kind,
      summary: input.summary,
      reservationId: input.reservationId ?? null,
      userId: input.userId ?? null,
      residenceId: input.residenceId ?? null,
      callDirection: input.callDirection ?? null,
      callParty: input.callParty ?? null,
      callOutcome: input.callOutcome ?? null,
      details: input.details ?? Prisma.DbNull,
      actorId: input.actorId ?? null,
      actorName,
      source: input.source ?? "SYSTEM",
    },
  });
}

/**
 * The same, for call sites that must not be able to fail because of logging.
 *
 * Used by every automatic hook. Deliberately not `async`, so it cannot be
 * awaited by accident and cannot add a round-trip to a request that is
 * finishing.
 */
export function log(input: RecordInput): void {
  void record(input).catch((error) => {
    console.warn(`[activity] ${input.kind} not logged:`, error instanceof Error ? error.message : error);
  });
}

/** The fields worth reporting when a booking is edited, and how to say them. */
const TRACKED: Record<string, { label: string; format?: (v: unknown) => string }> = {
  startDate: { label: "تاریخ شروع", format: (v) => faDate(v) },
  endDate: { label: "تاریخ پایان", format: (v) => faDate(v) },
  daysCount: { label: "تعداد شب", format: (v) => fa(Number(v)) },
  guestsCount: { label: "تعداد مهمان", format: (v) => fa(Number(v)) },
  totalAmount: { label: "مبلغ کل اجاره", format: (v) => `${fa(Number(v))} تومان` },
  paidAmount: { label: "پرداختی مهمان", format: (v) => `${fa(Number(v))} تومان` },
  hostShare: { label: "سهم میزبان", format: (v) => `${fa(Number(v))} تومان` },
  websiteShare: { label: "کارمزد سایت", format: (v) => `${fa(Number(v))} تومان` },
  clearRemainder: { label: "مانده واریز", format: (v) => `${fa(Number(v))} تومان` },
  expiryDate: { label: "مهلت", format: (v) => faDateTime(v) },
};

function faDate(v: unknown): string {
  if (!v) return "—";
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(new Date(v as string));
  } catch {
    return String(v);
  }
}

function faDateTime(v: unknown): string {
  if (!v) return "—";
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(
      new Date(v as string)
    );
  } catch {
    return String(v);
  }
}

const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  return a === b;
};

/**
 * Compares a booking before and after an edit, and logs what actually moved.
 *
 * This is the whole integration surface for automatic entries: a caller that
 * changes a reservation passes the two rows and is done. It writes nothing
 * when nothing tracked changed, so it can be called unconditionally — which is
 * the only way it stays correct as fields are added.
 */
export function diffAndLog(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  context: {
    reservationId: number;
    actorId?: number | null;
    actorName?: string | null;
    source?: string;
    /** Prefix for the summary, e.g. "ویرایش از پنل". */
    reason?: string | null;
  }
): void {
  const changes: { field: string; label: string; from: string; to: string }[] = [];

  for (const [field, meta] of Object.entries(TRACKED)) {
    if (!(field in after)) continue;
    if (same(before[field], after[field])) continue;

    const fmt = meta.format ?? ((v: unknown) => (v == null ? "—" : String(v)));
    changes.push({
      field,
      label: meta.label,
      from: fmt(before[field]),
      to: fmt(after[field]),
    });
  }

  if (changes.length === 0) return;

  const summary =
    (context.reason ? `${context.reason}: ` : "") +
    changes.map((c) => `${c.label} ${c.from} ← ${c.to}`).join("، ");

  log({
    kind: "FIELD_CHANGE",
    reservationId: context.reservationId,
    summary,
    // The readable line is what the timeline shows; the structured version is
    // what anyone auditing later actually needs.
    details: { changes } as unknown as Prisma.InputJsonValue,
    actorId: context.actorId,
    actorName: context.actorName,
    source: context.source ?? "SYSTEM",
  });
}

const CALL_LABEL: Record<string, string> = {
  INBOUND_GUEST: "تماس ورودی از مهمان",
  OUTBOUND_GUEST: "تماس خروجی به مهمان",
  INBOUND_HOST: "تماس ورودی از میزبان",
  OUTBOUND_HOST: "تماس خروجی به میزبان",
  INBOUND_OTHER: "تماس ورودی",
  OUTBOUND_OTHER: "تماس خروجی",
};

/**
 * Logs a call an admin made or took.
 *
 * Odoo had four buttons for this — call to/from host, call to/from guest — and
 * they are one entry with two dimensions here, because that is what they are.
 */
export async function logCall(input: {
  direction: CallDirection;
  party: CallParty;
  summary: string;
  outcome?: string | null;
  reservationId?: number | null;
  userId?: number | null;
  actorId: number;
}) {
  const summary = input.summary?.trim();
  if (!summary) throw AppError.badRequest("خلاصه‌ی تماس الزامی است");

  const actor = await prisma.user.findUnique({
    where: { id: input.actorId },
    select: { name: true, phone: true },
  });

  // A call about a booking is also about the person on the other end, so the
  // party is resolved to a user id — that is what makes their profile able to
  // show every call they were part of, not only the ones with no booking.
  let userId = input.userId ?? null;
  if (!userId && input.reservationId) {
    const r = await prisma.reservation.findUnique({
      where: { id: input.reservationId },
      select: { guestId: true, hostId: true },
    });
    if (r) userId = input.party === "HOST" ? r.hostId : input.party === "GUEST" ? r.guestId : null;
  }

  return record({
    kind: "CALL",
    reservationId: input.reservationId ?? null,
    userId,
    callDirection: input.direction,
    callParty: input.party,
    callOutcome: input.outcome ?? null,
    summary,
    details: {
      label: CALL_LABEL[`${input.direction}_${input.party}`] ?? "تماس",
    } as unknown as Prisma.InputJsonValue,
    actorId: input.actorId,
    actorName: actor?.name || actor?.phone || `ادمین #${input.actorId}`,
    source: "MANUAL",
  });
}

export interface ListFilters {
  reservationId?: number;
  userId?: number;
  kind?: ActivityKind;
  actorId?: number;
  from?: Date;
  to?: Date;
  cursor?: number;
  take?: number;
}

/**
 * The timeline, newest first.
 *
 * Cursor-based rather than offset: this table only grows, and page 40 of an
 * offset query gets slower every week.
 */
export async function list(filters: ListFilters) {
  const take = Math.min(Math.max(filters.take ?? 30, 1), 100);

  const where: Prisma.ActivityLogWhereInput = {
    ...(filters.reservationId ? { reservationId: filters.reservationId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            // The "to" of a date range means the end of that day, not its
            // midnight — otherwise choosing today as both ends finds nothing.
            ...(filters.to ? { lte: endOfDay(filters.to) } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.activityLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: take + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: {
      reservation: { select: { id: true, reference: true } },
      user: { select: { id: true, name: true, phone: true } },
    },
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return {
    items: items.map((r) => ({
      id: r.id,
      kind: r.kind,
      summary: r.summary,
      details: r.details,
      call:
        r.kind === "CALL"
          ? {
              direction: r.callDirection,
              party: r.callParty,
              outcome: r.callOutcome,
              label: CALL_LABEL[`${r.callDirection}_${r.callParty}`] ?? "تماس",
            }
          : null,
      actor_name: r.actorName,
      actor_id: r.actorId,
      source: r.source,
      reservation: r.reservation,
      user: r.user,
      created_at: r.createdAt,
    })),
    next_cursor: hasMore ? items[items.length - 1].id : null,
  };
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** The admins who have written to the log, for the filter dropdown. */
export async function actors() {
  const rows = await prisma.activityLog.groupBy({
    by: ["actorId", "actorName"],
    where: { actorId: { not: null } },
    _count: true,
    orderBy: { _count: { actorId: "desc" } },
    take: 50,
  });

  return rows.map((r) => ({ id: r.actorId, name: r.actorName, count: r._count }));
}
