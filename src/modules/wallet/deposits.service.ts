import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * Paying hosts — Odoo's `x_clearing`, rebuilt.
 *
 * Two different things were called "تسویه" in the old system and they are kept
 * apart here:
 *
 *   - `SettlementRequest` (x_clearing_requests, 711 rows) is the host asking
 *     to be paid. It is a queue of requests to approve or reject.
 *   - a deposit (x_clearing) is the site actually sending money, against a
 *     specific booking, with a transaction reference. It does not need a
 *     request first, and the common case has none: an admin settling a
 *     booking before the guest has even arrived.
 *
 * A deposit is what makes `settledAmount` on a reservation move, and what
 * `مانده واریز` is measured against.
 */

const round = (n: number) => Math.round(n * 100) / 100;

export interface CreateDepositInput {
  hostId: number;
  reservationId?: number | null;
  amount: number;
  txnId?: string | null;
  sender?: string | null;
  description?: string | null;
  depositedAt?: Date | null;
  adminId: number;
}

/**
 * Records money sent to a host, and takes it out of their wallet in the same
 * database transaction.
 *
 * Recording the payment and reducing the balance are one act. Split apart,
 * the first failure leaves a host who has been paid twice according to the
 * wallet, or paid nothing according to the ledger.
 */
export async function createDeposit(input: CreateDepositInput) {
  const amount = round(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest("مبلغ واریز نامعتبر است");
  }

  const reservation = input.reservationId
    ? await prisma.reservation.findUnique({
        where: { id: input.reservationId },
        select: { id: true, hostId: true, reference: true, hostShare: true, settledAmount: true },
      })
    : null;

  if (input.reservationId && !reservation) {
    throw AppError.notFound("رزرو پیدا نشد");
  }

  if (reservation && reservation.hostId !== input.hostId) {
    throw AppError.badRequest("این رزرو متعلق به این میزبان نیست");
  }

  // Paying more than a booking is worth is almost always a typo, and it is
  // cheaper to refuse than to unpick afterwards.
  if (reservation) {
    const remaining = round((reservation.hostShare ?? 0) - reservation.settledAmount);
    if (amount > remaining) {
      throw AppError.badRequest(
        `مانده سهم میزبان برای این رزرو ${remaining.toLocaleString("fa-IR")} تومان است`
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId: input.hostId } });
    if (!wallet) throw AppError.badRequest("کیف پول این میزبان هنوز ساخته نشده است");

    // Held money is not payable. It becomes payable on the day the stay
    // starts, and paying it out before then would defeat the hold.
    if (wallet.balance < amount) {
      throw AppError.badRequest(
        `موجودی قابل برداشت میزبان ${wallet.balance.toLocaleString("fa-IR")} تومان است`
      );
    }

    const balance = round(wallet.balance - amount);

    await tx.wallet.update({ where: { id: wallet.id }, data: { balance } });

    const description =
      input.description?.trim() ||
      (reservation ? `واریز سهم میزبان بابت رزرو ${reservation.reference}` : "واریز به میزبان");

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: "SETTLEMENT",
        amount: -amount,
        balanceAfter: balance,
        description,
        reservationId: reservation?.id ?? null,
      },
    });

    if (reservation) {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { settledAmount: round(reservation.settledAmount + amount) },
      });
    }

    return tx.hostDeposit.create({
      data: {
        hostId: input.hostId,
        reservationId: reservation?.id ?? null,
        amount,
        txnId: input.txnId?.trim() || null,
        sender: input.sender?.trim() || null,
        description,
        depositedAt: input.depositedAt ?? new Date(),
        createdById: input.adminId,
      },
    });
  });
}

export type PayableFilter = "unpaid" | "partial" | "settled" | "all";

/**
 * The payables queue: bookings whose host has money coming, and how much of it
 * has been sent.
 *
 * Only DONE bookings appear. Anything earlier has not been paid for, so the
 * site is not holding the host's money yet and there is nothing to deposit.
 *
 * And only bookings that credited this system's wallet. Without that clause
 * the queue was 29,524 rows long: every reservation migrated from Odoo has a
 * `hostShare` and a `settledAmount` of zero, which reads as "never paid" when
 * the truth is "paid years ago, by a system whose payout records we did not
 * migrate". A deposit against one of those would be refused anyway — the
 * host's balance here is zero — but a queue that is 99.99% rows nobody should
 * touch is not a queue, and the few that matter would never be found in it.
 */
export async function listPayables(params: {
  page?: number;
  pageSize?: number;
  hostId?: number;
  filter?: PayableFilter;
  q?: string;
}) {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);

  const filter = params.filter ?? "unpaid";
  const where: Prisma.ReservationWhereInput = {
    state: "DONE",
    hostShare: { gt: 0 },
    walletTransactions: { some: { kind: "BOOKING_INCOME" } },
    ...(params.hostId ? { hostId: params.hostId } : {}),
    ...(params.q
      ? {
          OR: [
            { reference: { contains: params.q, mode: "insensitive" } },
            { host: { phone: { contains: params.q } } },
            { host: { name: { contains: params.q, mode: "insensitive" } } },
          ],
        }
      : {}),
    ...(filter === "unpaid" ? { settledAmount: { lte: 0 } } : {}),
    ...(filter === "partial" ? { settledAmount: { gt: 0 } } : {}),
    ...(filter === "settled" ? { settledAmount: { gt: 0 } } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      orderBy: { startDate: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        reference: true,
        startDate: true,
        endDate: true,
        totalAmount: true,
        paidAmount: true,
        websiteShare: true,
        vatAmount: true,
        guestCommission: true,
        hostShare: true,
        settledAmount: true,
        commissionPercent: true,
        host: { select: { id: true, name: true, phone: true } },
        residence: { select: { id: true, name: true } },
      },
    }),
  ]);

  // "Fully settled" is not a column, and making it one would mean a second
  // number that can disagree with `settledAmount`. It is derived here, and
  // the partial/settled split is done in memory over one page rather than in
  // SQL comparing two columns.
  const items = rows
    .map((r) => ({
      ...r,
      remainder: round((r.hostShare ?? 0) - r.settledAmount),
    }))
    .filter((r) =>
      filter === "partial" ? r.remainder > 0 : filter === "settled" ? r.remainder <= 0 : true
    );

  return { total, page, pageSize, items };
}

export async function listDeposits(params: { hostId?: number; reservationId?: number; take?: number }) {
  return prisma.hostDeposit.findMany({
    where: {
      ...(params.hostId ? { hostId: params.hostId } : {}),
      ...(params.reservationId ? { reservationId: params.reservationId } : {}),
    },
    orderBy: { id: "desc" },
    take: Math.min(params.take ?? 50, 200),
    include: {
      host: { select: { id: true, name: true, phone: true } },
      reservation: { select: { id: true, reference: true } },
    },
  });
}
