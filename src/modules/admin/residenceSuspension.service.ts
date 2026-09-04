import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import { syncPublishedFlag } from "@/modules/residences/residences.service";

/**
 * Admin suspension — independent of `state` and of the host's own
 * `deactivatedAt`. A suspended listing's `state` stays PUBLISHED; nothing
 * about the approval it already earned is revoked, it is just hidden until
 * lifted. `syncPublishedFlag` is what actually forces `published` false —
 * this only sets the reason and lets that function apply it, so it composes
 * correctly with an open MANDATORY defect on the same listing.
 */
export async function suspend(input: {
  residenceId: number;
  internalNote: string;
  reason: string;
  actorId: number;
}) {
  const residence = await prisma.residence.findUnique({
    where: { id: input.residenceId },
    select: { id: true, name: true, suspendedAt: true },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");
  if (residence.suspendedAt) throw AppError.badRequest("این اقامتگاه از قبل معلق است");

  await prisma.residence.update({
    where: { id: input.residenceId },
    data: {
      suspendedAt: new Date(),
      suspensionInternalNote: input.internalNote,
      suspensionReason: input.reason,
    },
  });

  const updated = await syncPublishedFlag(input.residenceId);

  activity.log({
    kind: "STATE_CHANGE",
    residenceId: input.residenceId,
    summary: `اقامتگاه «${residence.name}» توسط ادمین معلق شد`,
    details: { internalNote: input.internalNote, reason: input.reason } as never,
    actorId: input.actorId,
    source: "ADMIN",
  });

  return updated;
}

export async function unsuspend(residenceId: number, actorId: number) {
  const residence = await prisma.residence.findUnique({
    where: { id: residenceId },
    select: { id: true, name: true, suspendedAt: true },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");
  if (!residence.suspendedAt) throw AppError.badRequest("این اقامتگاه معلق نیست");

  await prisma.residence.update({
    where: { id: residenceId },
    data: { suspendedAt: null, suspensionInternalNote: null, suspensionReason: null },
  });

  // Restores `published` only if nothing else — an open MANDATORY defect,
  // or the listing simply not being PUBLISHED — still says it shouldn't.
  const updated = await syncPublishedFlag(residenceId);

  activity.log({
    kind: "STATE_CHANGE",
    residenceId,
    summary: `تعلیق اقامتگاه «${residence.name}» رفع شد`,
    details: {} as never,
    actorId,
    source: "ADMIN",
  });

  return updated;
}
