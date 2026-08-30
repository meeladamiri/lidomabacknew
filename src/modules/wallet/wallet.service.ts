import { Prisma, type WalletTransactionKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { getSettings } from "@/modules/settings/reservationSettings.service";

const DEFAULT_TAKE = 20;
const MAX_TAKE = 50;


/**
 * Money is stored in whole tomans, but Float leaves room for rounding dust to
 * accumulate across thousands of rows. Every write goes through this.
 */
const round = (n: number) => Math.round(n * 100) / 100;

/** A wallet is created on first use rather than at signup, so most users never get a row. */
async function ensureWallet(userId: number, tx: Prisma.TransactionClient = prisma) {
  const existing = await tx.wallet.findUnique({ where: { userId } });
  if (existing) return existing;

  try {
    return await tx.wallet.create({ data: { userId } });
  } catch (error) {
    // Two concurrent first-uses; the loser reads what the winner wrote.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return tx.wallet.findUniqueOrThrow({ where: { userId } });
    }
    throw error;
  }
}

export interface CreditInput {
  userId: number;
  kind: WalletTransactionKind;
  amount: number;
  description: string;
  reservationId?: number | null;
  /** Held rather than withdrawable — a stay that has not finished yet. */
  blocked?: boolean;
}

/**
 * Moves money and writes the ledger row, in one database transaction.
 *
 * The balance and the ledger are written together or not at all. That is the
 * whole reason the stored balances are trustworthy enough to read directly
 * instead of summing the ledger on every page load.
 *
 * A negative `amount` is a withdrawal and is checked against the balance
 * inside the transaction, so two concurrent payout requests cannot both pass
 * a check that was true before either of them ran.
 */
export async function credit(input: CreditInput) {
  const amount = round(input.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    throw AppError.badRequest("مبلغ تراکنش نامعتبر است");
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await ensureWallet(input.userId, tx);

    const blocked = input.blocked ?? false;
    const current = blocked ? wallet.blockedBalance : wallet.balance;
    const next = round(current + amount);

    if (next < 0) {
      throw AppError.badRequest("موجودی کافی نیست");
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: blocked ? { blockedBalance: next } : { balance: next },
    });

    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: input.kind,
        amount,
        balanceAfter: next,
        description: input.description,
        reservationId: input.reservationId ?? null,
      },
    });

    return { wallet: updated, transaction };
  });
}

/**
 * Moves money from held to withdrawable — a stay finished and the refund
 * window closed.
 */
export async function release(userId: number, amount: number, description: string) {
  const value = round(amount);
  if (value <= 0) throw AppError.badRequest("مبلغ نامعتبر است");

  return prisma.$transaction(async (tx) => {
    const wallet = await ensureWallet(userId, tx);
    if (wallet.blockedBalance < value) {
      throw AppError.badRequest("موجودی مسدود کافی نیست");
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        blockedBalance: round(wallet.blockedBalance - value),
        balance: round(wallet.balance + value),
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: "BOOKING_INCOME",
        amount: value,
        balanceAfter: updated.balance,
        description,
      },
    });

    return updated;
  });
}

export async function summary(userId: number) {
  const [wallet, bank, settings] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.bankAccount.findUnique({ where: { userId } }),
    getSettings(),
  ]);

  return {
    // A user with no wallet row has no money, which is a balance of zero, not
    // an error and not an empty page.
    credit_balance: wallet?.balance ?? 0,
    blocked_balance: wallet?.blockedBalance ?? 0,
    gift_balance: wallet?.giftBalance ?? 0,
    bank_account: {
      credit_number: bank?.cardNumber ?? null,
      credit_owner: bank?.cardOwnerName ?? null,
      shaba_number: bank?.shabaNumber ?? null,
      shaba_owner: bank?.shabaOwnerName ?? null,
    },
    // Sent with the balance so the payout sheet can state the floor instead of
    // carrying its own copy of the number and disagreeing with the server.
    min_settlement: settings.minSettlement,
  };
}

export async function listTransactions(
  userId: number,
  opts: { cursor?: number; take?: number } = {}
) {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), MAX_TAKE);
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) return { items: [], next_cursor: null };

  const rows = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
    orderBy: { id: "desc" },
    take: take + 1,
    include: { reservation: { select: { reference: true } } },
  });

  const items = rows.slice(0, take);
  return {
    items: items.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      amount: t.amount,
      balance_after: t.balanceAfter,
      description: t.description,
      failure_reason: t.failureReason,
      reserve_code: t.reservation?.reference ?? null,
      created_at: t.createdAt.toISOString(),
    })),
    next_cursor: rows.length > take ? items[items.length - 1]!.id : null,
  };
}

export async function saveBankAccount(
  userId: number,
  data: {
    cardNumber?: string | null;
    cardOwnerName?: string | null;
    shabaNumber?: string | null;
    shabaOwnerName?: string | null;
  }
) {
  const account = await prisma.bankAccount.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  return {
    credit_number: account.cardNumber,
    credit_owner: account.cardOwnerName,
    shaba_number: account.shabaNumber,
    shaba_owner: account.shabaOwnerName,
  };
}
