import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";

/**
 * تغییر میزبان اقامتگاه.
 *
 * A listing changes hands — sold, or registered under the wrong account in
 * the first place — and until now the only fix was editing the database.
 *
 * What deliberately does *not* move with it: the bookings already made. A
 * reservation records who was paid, and rewriting `hostId` on a booking that
 * was settled to someone else would make the wallet and the deposit ledger
 * disagree with the invoice. The old host keeps the history; the new host
 * gets everything from here on.
 */
export async function changeHost(input: {
  residenceId: number;
  newHostId: number;
  note: string;
  actorId: number;
  dryRun?: boolean;
}) {
  const note = input.note?.trim();
  if (!note && !input.dryRun) throw AppError.badRequest("توضیح تغییر میزبان الزامی است");

  const residence = await prisma.residence.findUnique({
    where: { id: input.residenceId },
    select: {
      id: true,
      name: true,
      hostId: true,
      host: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");

  if (residence.hostId === input.newHostId) {
    throw AppError.badRequest("این اقامتگاه همین الان به نام همین کاربر است");
  }

  const newHost = await prisma.user.findUnique({
    where: { id: input.newHostId },
    select: { id: true, name: true, phone: true, isHost: true, isActive: true },
  });
  if (!newHost) throw AppError.notFound("کاربر مقصد پیدا نشد");
  if (!newHost.isActive) throw AppError.badRequest("کاربر مقصد غیرفعال است");

  // Bookings that are still live under the old host. Moving the listing does
  // not move these, and the panel says so before anything happens rather than
  // after someone notices the old host still sees them.
  const liveBookings = await prisma.reservation.count({
    where: {
      residenceId: residence.id,
      state: { in: ["DRAFT", "HOST_APPROVAL", "SECOND_PAYMENT"] },
    },
  });

  const unsettled = await prisma.reservation.aggregate({
    where: { residenceId: residence.id, state: "DONE" },
    _sum: { clearRemainder: true },
  });

  const preview = {
    residence: { id: residence.id, name: residence.name },
    from: residence.host,
    to: { id: newHost.id, name: newHost.name, phone: newHost.phone },
    warnings: [
      ...(liveBookings > 0
        ? [
            `${liveBookings.toLocaleString("fa-IR")} رزرو در جریان روی این اقامتگاه هست. این رزروها به نام میزبان قبلی می‌مانند.`,
          ]
        : []),
      ...((unsettled._sum.clearRemainder ?? 0) > 0
        ? [
            `${Math.round(unsettled._sum.clearRemainder ?? 0).toLocaleString("fa-IR")} تومان مانده‌ی تسویه‌نشده روی رزروهای قبلی است و به میزبان قبلی پرداخت می‌شود.`,
          ]
        : []),
      ...(!newHost.isHost ? ["کاربر مقصد تا الان میزبان نبوده و با این کار میزبان می‌شود."] : []),
    ],
  };

  if (input.dryRun) return preview;

  await prisma.$transaction(async (tx) => {
    await tx.residence.update({
      where: { id: residence.id },
      data: { hostId: newHost.id },
    });

    // Somebody who owns a listing is a host, whatever the flag said before.
    if (!newHost.isHost) {
      await tx.user.update({ where: { id: newHost.id }, data: { isHost: true } });
    }
  });

  activity.log({
    kind: "FIELD_CHANGE",
    residenceId: residence.id,
    userId: newHost.id,
    summary:
      `میزبان اقامتگاه «${residence.name}» از ${residence.host?.name ?? residence.host?.phone ?? "—"} ` +
      `به ${newHost.name ?? newHost.phone} تغییر کرد — ${note}`,
    details: { from: residence.hostId, to: newHost.id } as never,
    actorId: input.actorId,
    source: "HOST_CHANGE",
  });

  return preview;
}
