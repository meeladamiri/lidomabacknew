import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { getSettings } from "@/modules/settings/reservationSettings.service";

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Asks for a payout.
 *
 * The money leaves the withdrawable balance immediately, in the same
 * transaction that writes the request. Leaving it until an admin approves
 * would let a host request the same balance twice and be owed it twice — and
 * the second request would look perfectly valid at the moment it was made.
 *
 * A rejection puts it back. That is why REJECTED is a state here rather than a
 * deletion: the ledger has to show the round trip.
 */
export async function request(userId: number, amount: number) {
  const value = round(amount);

  // The floor is a setting rather than a constant: below it a payout costs
  // more in bank fees and handling than it moves, and where that line sits is
  // a business call that changes with the currency.
  const { minSettlement } = await getSettings();

  if (!Number.isFinite(value) || value < minSettlement) {
    throw AppError.badRequest(
      `حداقل مبلغ تسویه ${minSettlement.toLocaleString("fa-IR")} تومان است`
    );
  }

  const bank = await prisma.bankAccount.findUnique({ where: { userId } });
  if (!bank?.shabaNumber && !bank?.cardNumber) {
    throw AppError.badRequest("ابتدا شماره کارت یا شبا را ثبت کنید");
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet || wallet.balance < value) {
      throw AppError.badRequest("موجودی قابل برداشت کافی نیست");
    }

    // One open request at a time. Two in flight would each look affordable
    // against a balance that only covers one.
    const open = await tx.settlementRequest.findFirst({
      where: { userId, status: { in: ["REQUESTED", "APPROVED"] } },
      select: { id: true },
    });
    if (open) throw AppError.badRequest("یک درخواست تسویه در حال بررسی دارید");

    const balanceAfter = round(wallet.balance - value);

    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: "SETTLEMENT",
        status: "PENDING",
        amount: -value,
        balanceAfter,
        description: "درخواست تسویه",
      },
    });

    return tx.settlementRequest.create({
      data: {
        userId,
        amount: value,
        // Copied now: editing the card later must not redirect a payout that
        // is already being processed.
        cardNumber: bank.cardNumber,
        shabaNumber: bank.shabaNumber,
        ownerName: bank.shabaOwnerName ?? bank.cardOwnerName,
      },
    });
  });
}

export async function listForUser(userId: number, opts: { cursor?: number; take?: number } = {}) {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 50);
  const rows = await prisma.settlementRequest.findMany({
    where: { userId, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
    orderBy: { id: "desc" },
    take: take + 1,
  });

  const items = rows.slice(0, take);
  return {
    items: items.map(toRow),
    next_cursor: rows.length > take ? items[items.length - 1]!.id : null,
  };
}

// ------------------------------------------------------------------- admin ---

export async function listForAdmin(opts: {
  status?: "REQUESTED" | "APPROVED" | "PAID" | "REJECTED";
  cursor?: number;
  take?: number;
}) {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 50);
  const rows = await prisma.settlementRequest.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: take + 1,
    include: {
      user: { select: { id: true, name: true, phone: true } },
      processedBy: { select: { id: true, name: true } },
    },
  });

  const items = rows.slice(0, take);
  return {
    items: items.map((r) => ({
      ...toRow(r),
      user: r.user ? { id: r.user.id, name: r.user.name, phone: r.user.phone } : null,
      processed_by: r.processedBy?.name ?? null,
    })),
    next_cursor: rows.length > take ? items[items.length - 1]!.id : null,
  };
}

/** REQUESTED → APPROVED. Money already left the balance; this records intent to pay. */
export async function approve(id: number, adminId: number, note?: string) {
  const result = await prisma.settlementRequest.updateMany({
    where: { id, status: "REQUESTED" },
    data: { status: "APPROVED", adminNote: note, processedById: adminId, processedAt: new Date() },
  });

  // Guarded by the status in the WHERE clause rather than a read-then-write,
  // so two admins clicking at once cannot both approve.
  if (result.count === 0) {
    throw AppError.badRequest("وضعیت این درخواست اجازه‌ی این تغییر را نمی‌دهد");
  }
  return prisma.settlementRequest.findUniqueOrThrow({ where: { id } });
}

/** APPROVED → PAID. The transfer happened; the pending ledger row settles. */
export async function markPaid(id: number, adminId: number, note?: string) {
  return prisma.$transaction(async (tx) => {
    const settlement = await tx.settlementRequest.findUnique({ where: { id } });
    if (!settlement) throw AppError.notFound("درخواست تسویه پیدا نشد");
    if (settlement.status !== "APPROVED") {
      throw AppError.badRequest("فقط درخواست تأییدشده را می‌توان پرداخت‌شده کرد");
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: settlement.userId } });
    if (wallet) {
      await tx.walletTransaction.updateMany({
        where: { walletId: wallet.id, kind: "SETTLEMENT", status: "PENDING" },
        data: { status: "DONE", description: "تسویه پرداخت شد" },
      });
    }

    return tx.settlementRequest.update({
      where: { id },
      data: {
        status: "PAID",
        adminNote: note ?? settlement.adminNote,
        processedById: adminId,
        processedAt: new Date(),
      },
    });
  });
}

/**
 * Rejects and refunds.
 *
 * The amount goes back to the withdrawable balance and the pending ledger row
 * is marked failed with the reason, rather than deleted — a host who watched
 * money leave has to be able to see it come back, and why.
 */
export async function reject(id: number, adminId: number, reason: string) {
  return prisma.$transaction(async (tx) => {
    const settlement = await tx.settlementRequest.findUnique({ where: { id } });
    if (!settlement) throw AppError.notFound("درخواست تسویه پیدا نشد");
    if (settlement.status === "PAID" || settlement.status === "REJECTED") {
      throw AppError.badRequest("این درخواست قبلاً بسته شده است");
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: settlement.userId } });
    if (wallet) {
      const restored = round(wallet.balance + settlement.amount);
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: restored } });

      await tx.walletTransaction.updateMany({
        where: { walletId: wallet.id, kind: "SETTLEMENT", status: "PENDING" },
        data: { status: "FAILED", failureReason: reason },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          kind: "SETTLEMENT",
          status: "DONE",
          amount: settlement.amount,
          balanceAfter: restored,
          description: "بازگشت مبلغ تسویه رد شده",
        },
      });
    }

    return tx.settlementRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        adminNote: reason,
        processedById: adminId,
        processedAt: new Date(),
      },
    });
  });
}

function toRow(r: {
  id: number;
  amount: number;
  status: string;
  cardNumber: string | null;
  shabaNumber: string | null;
  ownerName: string | null;
  adminNote: string | null;
  processedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    amount: r.amount,
    status: r.status,
    // Only the last four digits leave the server for a list view. The full
    // number stays in the record for whoever makes the transfer.
    card_last4: r.cardNumber ? r.cardNumber.slice(-4) : null,
    shaba_number: r.shabaNumber,
    owner_name: r.ownerName,
    admin_note: r.adminNote,
    processed_at: r.processedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}
