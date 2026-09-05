import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import * as residencesService from "@/modules/residences/residences.service";
import { openSupportThreadFromAdmin } from "@/modules/conversations/conversations.service";
import { record as recordNotification } from "@/modules/notifications/notifications.service";

const STEP_LABEL: Record<string, string> = {
  specs: "نام و مشخصات",
  amenities: "امکانات",
  rules: "قوانین و شرایط",
  pricing: "نرخ‌گذاری",
  capacity: "ظرفیت",
  gallery: "تصاویر",
  documents: "مدارک",
};

const labelFor = (steps: string[]) => steps.map((step) => STEP_LABEL[step] ?? step).join("، ");

/** Telling the host never matters more than the decision itself landing — a
 * failed SMS gateway or a full inbox must not roll back an approval. */
async function tell(what: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.warn(`[residence-edits] ${what} failed:`, error);
  }
}

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
    case "gallery":
      return residencesService.applyGalleryChange(hostId, residenceId, payload);
    case "documents":
      return residencesService.updateDocuments(hostId, residenceId, payload);
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

  await tell("approval notification", () =>
    recordNotification({
      userId: residence.hostId,
      kind: "MESSAGE_RECEIVED",
      title: "ویرایش اقامتگاه تأیید شد",
      body: `تغییرات شما (${labelFor(Object.keys(pending))}) در اقامتگاه «${residence.name}» تأیید و روی سایت اعمال شد.`,
      linkUrl: "/residences/list",
      // Not keyed to the residence: a host can edit and be approved many
      // times, and the idempotency index would swallow every round but one.
      entityType: null,
      entityId: null,
    })
  );

  return prisma.residence.findUniqueOrThrow({ where: { id: residenceId } });
}

export async function reject(residenceId: number, reason: string, actorId: number) {
  const residence = await prisma.residence.findUniqueOrThrow({
    where: { id: residenceId },
    select: { name: true, hostId: true, pendingChanges: true },
  });
  if (!residence.pendingChanges) {
    throw AppError.badRequest("تغییری در انتظار بررسی برای این اقامتگاه ثبت نشده است");
  }

  const steps = Object.keys(residence.pendingChanges as PendingChanges);

  await prisma.residence.update({
    where: { id: residenceId },
    data: { pendingChanges: Prisma.JsonNull, pendingChangesSubmittedAt: null },
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId,
    summary: `تغییرات در انتظار بررسی اقامتگاه «${residence.name}» رد شد`,
    details: { reason, steps } as never,
    actorId,
    source: "ADMIN",
  });

  // A rejection is the one outcome that needs a conversation rather than a
  // line in a list: the host has to read *why* and be able to answer.
  await tell("rejection support thread", async () => {
    const conversation = await openSupportThreadFromAdmin({
      userId: residence.hostId,
      adminId: actorId,
      subject: `ویرایش اقامتگاه «${residence.name}»`,
      body: `تغییراتی که برای اقامتگاه «${residence.name}» ثبت کرده بودید (${labelFor(steps)}) تأیید نشد.\n\nدلیل: ${reason}\n\nمی‌توانید اصلاحش کنید و دوباره ثبت کنید. اگر سؤالی دارید همین‌جا بپرسید.`,
    });

    await recordNotification({
      userId: residence.hostId,
      kind: "MESSAGE_RECEIVED",
      title: "پیامی از پشتیبانی لیدوماتریپ دارید",
      body: `درباره‌ی ویرایش اقامتگاه «${residence.name}» پیامی از پشتیبانی برایتان ارسال شد.`,
      linkUrl: `/chats?c=${conversation.publicId}`,
      entityType: null,
      entityId: null,
    });
  });
}
