/**
 * The content of the host submission wizard: what each step says, and what the
 * first three steps offer as choices.
 *
 * All of this used to be hardcoded in the front's bundle — a map of fourteen
 * titles, three arrays of options, and one shared placeholder image standing in
 * for every tile. Odoo had it configurable; the migration off Odoo did not
 * carry that surface across, so nobody could rename a step, explain one, add a
 * region, or put a real photograph on a tile without a deploy.
 *
 * Read on every wizard page load, so it is cached. Panel writes drop the cache
 * through the same middleware every other admin write goes through.
 */

import type { Prisma, WizardOptionKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cached, dropKeys, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";

const CACHE_KEY = "catalog:wizard";

export interface WizardContent {
  steps: {
    step: number;
    title: string;
    description: string | null;
    help_text: string | null;
    icon_url: string | null;
  }[];
  options: Record<
    WizardOptionKind,
    { id: number; name: string; description: string | null; image_url: string | null }[]
  >;
}

/**
 * Everything the wizard needs to render, in one payload.
 *
 * One request rather than one per step: the whole thing is a few kilobytes,
 * and fetching it per step is the pattern that made the wizard feel slow in
 * the first place.
 */
export async function getWizardContent(): Promise<WizardContent> {
  return cached(CACHE_KEY, TTL.catalog, async () => {
    const [steps, options] = await Promise.all([
      prisma.wizardStep.findMany({
        where: { isEnabled: true },
        orderBy: { step: "asc" },
        select: { step: true, title: true, description: true, helpText: true, iconUrl: true },
      }),
      prisma.wizardOption.findMany({
        where: { isActive: true },
        orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
        select: { id: true, kind: true, name: true, description: true, imageUrl: true },
      }),
    ]);

    const grouped = { RES_TYPE: [], REGION: [], RENT_TYPE: [] } as WizardContent["options"];
    for (const option of options) {
      grouped[option.kind].push({
        id: option.id,
        name: option.name,
        description: option.description,
        image_url: option.imageUrl,
      });
    }

    return {
      steps: steps.map((s) => ({
        step: s.step,
        title: s.title,
        description: s.description,
        help_text: s.helpText,
        icon_url: s.iconUrl,
      })),
      options: grouped,
    };
  });
}

// ------------------------------------------------------------------ admin ---

export async function adminListWizardContent() {
  const [steps, options] = await Promise.all([
    prisma.wizardStep.findMany({ orderBy: { step: "asc" } }),
    prisma.wizardOption.findMany({ orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] }),
  ]);
  return { steps, options };
}

/**
 * Upsert by step number rather than by id.
 *
 * The panel edits "step 7", not "row 42" — and a step that has never been
 * customised has no row yet. Keying on the number means the panel does not
 * have to know which of the two it is dealing with.
 */
export async function adminSaveStep(
  step: number,
  data: { title?: string; description?: string | null; helpText?: string | null; iconUrl?: string | null; isEnabled?: boolean }
) {
  const saved = await prisma.wizardStep.upsert({
    where: { step },
    create: { step, title: data.title || `مرحله ${step}`, ...data },
    update: data,
  });
  await dropKeys(CACHE_KEY);
  return saved;
}

export async function adminCreateOption(data: {
  kind: WizardOptionKind;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
}) {
  const created = await prisma.wizardOption.create({ data });
  await dropKeys(CACHE_KEY);
  return created;
}

export async function adminUpdateOption(
  id: number,
  data: Prisma.WizardOptionUpdateInput
) {
  const updated = await prisma.wizardOption.update({ where: { id }, data });
  await dropKeys(CACHE_KEY);
  return updated;
}

/**
 * Deactivate rather than delete.
 *
 * The option's `name` is the string written onto every residence that chose
 * it. Removing the row does not remove those, but it does make the value
 * unexplainable in the panel — better to keep the row and stop offering it.
 */
export async function adminDeactivateOption(id: number) {
  const option = await prisma.wizardOption.findUnique({ where: { id } });
  if (!option) throw AppError.notFound("گزینه پیدا نشد");

  const updated = await prisma.wizardOption.update({
    where: { id },
    data: { isActive: !option.isActive },
  });
  await dropKeys(CACHE_KEY);
  return updated;
}
