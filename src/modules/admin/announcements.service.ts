import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import type { AnnouncementAudience, AnnouncementStyle, Prisma } from "@prisma/client";

/**
 * اطلاعیه‌ها — notices the ops team puts on people's dashboards.
 *
 * The dashboard has read an `announcement` field since the migration and
 * rendered it in a dialog. Nothing ever wrote one, so it was dead code.
 *
 * ## What decides whether someone sees one
 *
 * Three things, all of which have to be true: it is switched on, today falls
 * inside its window if it has one, and its audience includes this person.
 * Kept in one `where` so the panel's preview and the live dashboard cannot
 * disagree about who is being shown what.
 */

export function visibleWhere(isHost: boolean, now = new Date()): Prisma.AnnouncementWhereInput {
  return {
    isActive: true,
    // An open-ended date is "no bound", not "excluded" — most notices have
    // neither and should simply run until switched off.
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
    audience: { in: isHost ? ["ALL", "HOSTS"] : ["ALL", "GUESTS"] },
  };
}

/** What a dashboard shows this person, in order. */
export async function forUser(isHost: boolean) {
  return prisma.announcement.findMany({
    where: visibleWhere(isHost),
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      body: true,
      imageUrl: true,
      linkUrl: true,
      linkLabel: true,
      style: true,
    },
  });
}

// ------------------------------------------------------------------ admin

export async function list(params: { onlyActive?: boolean } = {}) {
  const items = await prisma.announcement.findMany({
    where: params.onlyActive ? { isActive: true } : {},
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    include: { createdBy: { select: { id: true, name: true } } },
  });

  const now = new Date();
  return items.map((a) => ({
    ...a,
    // Whether it is on screen *right now*, which is not the same as isActive:
    // a switched-on notice whose window has passed is showing nobody anything,
    // and the panel should say so rather than let someone wonder why.
    isLive:
      a.isActive &&
      (!a.startsAt || a.startsAt <= now) &&
      (!a.endsAt || a.endsAt >= now),
  }));
}

export interface AnnouncementInput {
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  audience?: AnnouncementAudience;
  style?: AnnouncementStyle;
  isActive?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  sortOrder?: number;
}

/** A link with no label is a link nobody can tell is a link. */
function check(input: AnnouncementInput) {
  if (input.endsAt && input.startsAt && input.endsAt < input.startsAt) {
    throw AppError.badRequest("تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد");
  }
  if (input.linkUrl && !input.linkLabel?.trim()) {
    throw AppError.badRequest("برای لینک، متن دکمه هم لازم است");
  }
  if (input.linkLabel?.trim() && !input.linkUrl) {
    throw AppError.badRequest("متن دکمه بدون لینک معنایی ندارد");
  }
}

export async function create(input: AnnouncementInput, actorId: number) {
  check(input);
  const announcement = await prisma.announcement.create({
    data: { ...input, createdById: actorId },
  });
  activity.log({
    kind: "FIELD_CHANGE",
    summary: `اطلاعیه «${announcement.title}» ساخته شد`,
    details: { announcementId: announcement.id, ...input } as never,
    actorId,
    source: "ADMIN",
  });
  return announcement;
}

export async function update(id: number, input: AnnouncementInput, actorId: number) {
  const before = await prisma.announcement.findUnique({ where: { id } });
  if (!before) throw AppError.notFound("اطلاعیه یافت نشد");
  check(input);

  const announcement = await prisma.announcement.update({ where: { id }, data: input });
  activity.log({
    kind: "FIELD_CHANGE",
    summary: `اطلاعیه «${announcement.title}» ویرایش شد`,
    details: { announcementId: id, before, after: announcement } as never,
    actorId,
    source: "ADMIN",
  });
  return announcement;
}

export async function remove(id: number, actorId: number) {
  const announcement = await prisma.announcement.findUnique({ where: { id } });
  if (!announcement) throw AppError.notFound("اطلاعیه یافت نشد");

  await prisma.announcement.delete({ where: { id } });
  activity.log({
    kind: "FIELD_CHANGE",
    summary: `اطلاعیه «${announcement.title}» حذف شد`,
    details: { announcementId: id, removed: announcement } as never,
    actorId,
    source: "ADMIN",
  });
  return { removed: true };
}
