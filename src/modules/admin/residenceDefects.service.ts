import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";
import { syncPublishedFlag } from "@/modules/residences/residences.service";
import type { ResidenceDefectSection, ResidenceDefectSeverity } from "@prisma/client";

const SECTION_LABEL: Record<ResidenceDefectSection, string> = {
  DETAILS: "نوع و منطقه",
  SPECS: "نام و توضیحات",
  LOCATION: "آدرس و محل دقیق",
  CAPACITY: "ظرفیت و اتاق‌ها",
  AMENITIES: "امکانات",
  PRICING: "نرخ‌گذاری",
  GALLERY: "گالری تصاویر",
  DOCUMENTS: "مدارک",
  RULES: "قوانین و شرایط",
  OTHER: "سایر",
};

/**
 * A new, itemized issue on a listing — new or already published.
 *
 * MANDATORY forces `published` false through `syncPublishedFlag` rather than
 * setting it here directly, so it composes correctly with suspension: a
 * listing that is *also* suspended stays unpublished when this defect is
 * later resolved, instead of this write blindly flipping it back on.
 */
export async function report(input: {
  residenceId: number;
  section: ResidenceDefectSection;
  severity: ResidenceDefectSeverity;
  description: string;
  actorId: number;
}) {
  const residence = await prisma.residence.findUnique({
    where: { id: input.residenceId },
    select: { id: true, name: true },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  const defect = await prisma.residenceDefect.create({
    data: {
      residenceId: input.residenceId,
      section: input.section,
      severity: input.severity,
      description: input.description,
      reportedById: input.actorId,
    },
  });

  await syncPublishedFlag(input.residenceId);

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: input.residenceId,
    summary: `نقص ${input.severity === "MANDATORY" ? "اجباری" : "پیشنهادی"} روی «${SECTION_LABEL[input.section]}» اقامتگاه «${residence.name}» ثبت شد`,
    details: { defectId: defect.id, section: input.section, severity: input.severity } as never,
    actorId: input.actorId,
    source: "ADMIN",
  });

  return defect;
}

/** An admin confirming the fix — the only thing that actually closes a defect. */
export async function resolve(defectId: number, actorId: number) {
  const defect = await prisma.residenceDefect.findUnique({ where: { id: defectId } });
  if (!defect) throw AppError.notFound("نقص پیدا نشد");
  if (defect.resolvedAt) throw AppError.badRequest("این نقص قبلاً برطرف شده است");

  const updated = await prisma.residenceDefect.update({
    where: { id: defectId },
    data: { resolvedAt: new Date(), resolvedById: actorId },
  });

  await syncPublishedFlag(defect.residenceId);

  const residence = await prisma.residence.findUnique({
    where: { id: defect.residenceId },
    select: { name: true },
  });
  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: defect.residenceId,
    summary: `نقص «${SECTION_LABEL[defect.section]}» اقامتگاه «${residence?.name ?? ""}» برطرف‌شده ثبت شد`,
    details: { defectId } as never,
    actorId,
    source: "ADMIN",
  });

  return updated;
}

export async function listForResidence(residenceId: number) {
  return prisma.residenceDefect.findMany({
    where: { residenceId },
    orderBy: { createdAt: "desc" },
  });
}
