import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import * as residencesService from "@/modules/residences/residences.service";

/**
 * A published listing's edit, waiting on an admin.
 *
 * `queuePendingChange` (residences.service.ts) is the only writer of this
 * object — one key per wizard step a host touched while the listing was
 * live, each holding exactly the payload that step's own PATCH received.
 * Approval replays each one through that *same* step function, so applying
 * an approved edit can never drift from what a direct (pre-publish) save of
 * the same step would have done.
 */
type PendingChanges = Record<string, unknown>;

async function applyStep(hostId: number, residenceId: number, stepKey: string, payload: any) {
  switch (stepKey) {
    case "specs":
      return residencesService.updateSpecs(hostId, residenceId, payload);
    case "amenities":
      return residencesService.updateAmenities(
        hostId,
        residenceId,
        payload.amenities,
        payload.other,
        undefined,
        payload.scopeIds
      );
    case "rules":
      return residencesService.updateRules(hostId, residenceId, payload);
    case "pricing":
      return residencesService.updatePricing(hostId, residenceId, payload);
    case "capacity":
      return residencesService.updateCapacity(hostId, residenceId, payload);
    default:
      // Not a bug worth failing the whole approval over — an unrecognised
      // key just never lands, and the activity log below still fires so it
      // doesn't disappear silently.
      return null;
  }
}

export async function approve(residenceId: number, actorId: number) {
  const residence = await prisma.residence.findUniqueOrThrow({ where: { id: residenceId } });
  const pending = residence.pendingChanges as PendingChanges | null;
  if (!pending || Object.keys(pending).length === 0) {
    throw AppError.badRequest("تغییری در انتظار بررسی برای این اقامتگاه ثبت نشده است");
  }

  for (const [stepKey, payload] of Object.entries(pending)) {
    await applyStep(residence.hostId, residenceId, stepKey, payload);
  }

  await prisma.residence.update({
    where: { id: residenceId },
    data: { pendingChanges: Prisma.JsonNull, pendingChangesSubmittedAt: null },
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId,
    summary: `تغییرات در انتظار بررسی اقامتگاه «${residence.name}» تأیید و روی سایت اعمال شد`,
    details: { steps: Object.keys(pending) } as never,
    actorId,
    source: "ADMIN",
  });

  return prisma.residence.findUniqueOrThrow({ where: { id: residenceId } });
}

export async function reject(residenceId: number, reason: string, actorId: number) {
  const residence = await prisma.residence.findUniqueOrThrow({
    where: { id: residenceId },
    select: { name: true, pendingChanges: true },
  });
  if (!residence.pendingChanges) {
    throw AppError.badRequest("تغییری در انتظار بررسی برای این اقامتگاه ثبت نشده است");
  }

  await prisma.residence.update({
    where: { id: residenceId },
    data: { pendingChanges: Prisma.JsonNull, pendingChangesSubmittedAt: null },
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId,
    summary: `تغییرات در انتظار بررسی اقامتگاه «${residence.name}» رد شد`,
    details: { reason } as never,
    actorId,
    source: "ADMIN",
  });
}
