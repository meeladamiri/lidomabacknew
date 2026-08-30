import { Prisma, type HostDepositKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * پنل واریزی — the finance team's settlement desk, rebuilt.
 *
 * This is the backend for the `/deposit` page that already exists in the
 * frontend: a date range of stays, every confirmed booking in it, what the
 * host is owed, what has been paid, and the forms to record a payment. The UI
 * is unchanged; only what it talks to is new.
 *
 * Two ledgers meet here and they are deliberately not merged:
 *
 *   - `Reservation.clearRemainder` is what the site owes on one booking. It is
 *     the number this panel is about, and the one Odoo kept.
 *   - `Wallet` is the host's balance in this system, which only exists for
 *     bookings completed here. Every migrated booking has none.
 *
 * So a payment always moves the booking's remainder, and moves the wallet only
 * when the wallet is actually holding that money. Requiring the wallet would
 * make the panel refuse every row that came from Odoo — which is all of them
 * today — and quietly crediting a wallet that never held the income would
 * invent money.
 */

const round = (n: number) => Math.round(n * 100) / 100;

/** The remaining figure, falling back to the subtraction when never set. */
function remainderOf(r: { hostShare: number | null; settledAmount: number; clearRemainder: number | null }) {
  if (r.clearRemainder != null) return round(r.clearRemainder);
  return round(Math.max((r.hostShare ?? 0) - r.settledAmount, 0));
}

const CHECKOUT_SELECT = {
  id: true,
  reference: true,
  state: true,
  startDate: true,
  endDate: true,
  totalAmount: true,
  hostShare: true,
  settledAmount: true,
  clearRemainder: true,
  salesDescription: true,
  createdAt: true,
  updatedAt: true,
  host: {
    select: {
      id: true,
      name: true,
      phone: true,
      avatarUrl: true,
      bankAccount: {
        select: {
          cardNumber: true,
          cardOwnerName: true,
          shabaNumber: true,
          shabaOwnerName: true,
        },
      },
    },
  },
  hostDeposits: {
    orderBy: { id: "desc" as const },
    select: {
      id: true,
      kind: true,
      amount: true,
      depositedAt: true,
      txnId: true,
      sender: true,
      payWith: true,
      payerName: true,
      description: true,
    },
  },
} satisfies Prisma.ReservationSelect;

type CheckoutRow = Prisma.ReservationGetPayload<{ select: typeof CHECKOUT_SELECT }>;

/**
 * Shapes one booking the way the existing panel reads it.
 *
 * The field names are Odoo's, not this codebase's, and deliberately so: the
 * 2,300 lines of UI in `components/Deposit` already speak them, and renaming
 * them here would mean rewriting a screen that works in order to change
 * nothing a user can see.
 */
function toPanelRow(r: CheckoutRow) {
  const bank = r.host?.bankAccount;

  return {
    order_id: r.id,
    order_reference: r.reference,
    order_status: r.state === "CANCEL" ? "cancel" : r.state.toLowerCase(),
    order_description: r.salesDescription ?? "",

    // Odoo's "تاریخ و ساعت قطعی" is when the booking became final. The nearest
    // truth here is when it was last moved into DONE, which is `updatedAt`.
    confirmation_date: r.updatedAt.toISOString(),
    start_date: r.startDate.toISOString(),

    host_id: r.host?.id ?? 0,
    host_name: r.host?.name ?? "",
    host_phone: r.host?.phone ?? "",
    host_image: r.host?.avatarUrl ?? "",

    credit_card: bank?.cardNumber ?? "",
    card_owner: bank?.cardOwnerName ?? "",
    shaba: bank?.shabaNumber ?? "",
    shaba_owner: bank?.shabaOwnerName ?? "",

    host_portion: round(r.hostShare ?? 0),
    clear_remainer: remainderOf(r),
    host_debit: round(
      r.hostDeposits.filter((d) => d.kind === "HOST_DEBIT").reduce((s, d) => s + d.amount, 0)
    ),

    transactions: r.hostDeposits.map((d) => ({
      amount: round(d.amount),
      date_time: d.depositedAt.toISOString(),
      description: d.description ?? "",
      payer: d.payerName ?? "",
      pay_with: d.payWith ?? "",
      reference: d.txnId ?? "",
      payment_type:
        d.kind === "DEPOSIT" ? "deposit" : d.kind === "HOST_DEBIT" ? "host_debit" : "remainder",
      // The panel splits these two: an adjustment is a correction to the
      // number, everything else is money that moved.
      type: d.kind === "ADJUSTMENT" ? "remainder_update" : "payment",
    })),
  };
}

/**
 * The bookings whose stay *starts* in the range.
 *
 * Named "checkouts" in Odoo, but it listed by start date — the panel's own
 * column is «تاریخ شروع» and the money becomes payable when the guest arrives.
 * Keeping its behaviour rather than its name.
 */
export async function getCheckouts(params: { startDate: Date; tillDate: Date }) {
  // The end of the chosen day, not its midnight: a range of one day has to
  // include that day.
  const till = new Date(params.tillDate);
  till.setHours(23, 59, 59, 999);

  const rows = await prisma.reservation.findMany({
    where: {
      // Cancelled bookings stay in the list — the panel renders a «کنسلی» tag
      // for them, because a cancellation after a deposit still has to be
      // settled somehow.
      state: { in: ["DONE", "CANCEL"] },
      hostShare: { not: null },
      startDate: { gte: params.startDate, lte: till },
    },
    orderBy: { startDate: "asc" },
    take: 500,
    select: CHECKOUT_SELECT,
  });

  return rows.map(toPanelRow);
}

export type SettleType = "remainder" | "deposit" | "host_debit";

const KIND_BY_TYPE: Record<SettleType, HostDepositKind> = {
  remainder: "REMAINDER",
  deposit: "DEPOSIT",
  host_debit: "HOST_DEBIT",
};

interface SettleInput {
  reservationId: number;
  amount: number;
  type: SettleType;
  desc?: string | null;
  reference?: string | null;
  payWith?: string | null;
  adminId: number;
  adminName: string;
}

/**
 * Records one payment against one booking.
 *
 * Everything moves in a single transaction: the deposit row, the booking's
 * remainder, the running settled total, and the host's wallet where there is
 * one. Any of those landing without the others is a number somebody will have
 * to reconcile by hand later.
 */
export async function saveSettleInfo(input: SettleInput) {
  const amount = round(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest("مبلغ نامعتبر است");
  }

  return prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({
      where: { id: input.reservationId },
      select: {
        id: true,
        reference: true,
        hostId: true,
        hostShare: true,
        settledAmount: true,
        clearRemainder: true,
      },
    });

    if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

    const remaining = remainderOf(reservation);
    if (amount > remaining) {
      throw AppError.badRequest(
        `مانده واریز این رزرو ${remaining.toLocaleString("fa-IR")} تومان است`
      );
    }

    const description =
      input.desc?.trim() ||
      (input.type === "deposit"
        ? `واریز بیعانه رزرو ${reservation.reference}`
        : input.type === "host_debit"
          ? `کسر بدهی میزبان بابت رزرو ${reservation.reference}`
          : `واریز مانده رزرو ${reservation.reference}`);

    const deposit = await tx.hostDeposit.create({
      data: {
        hostId: reservation.hostId,
        reservationId: reservation.id,
        kind: KIND_BY_TYPE[input.type],
        amount,
        txnId: input.reference?.trim() || null,
        payWith: input.payWith?.trim() || null,
        payerName: input.adminName || null,
        description,
        createdById: input.adminId,
      },
    });

    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        settledAmount: round(reservation.settledAmount + amount),
        clearRemainder: round(remaining - amount),
      },
    });

    // The wallet is this system's own ledger, and it only holds income for
    // bookings completed here. A migrated booking has none, and paying its
    // host is still a real thing that happened — so the wallet follows along
    // when it can and stays out of the way when it cannot.
    const wallet = await tx.wallet.findUnique({ where: { userId: reservation.hostId } });
    if (wallet && wallet.balance >= amount) {
      const balance = round(wallet.balance - amount);
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          kind: input.type === "host_debit" ? "ADJUSTMENT" : "SETTLEMENT",
          amount: -amount,
          balanceAfter: balance,
          description,
          reservationId: reservation.id,
        },
      });
    }

    return deposit;
  });
}

/**
 * One bank transfer covering several bookings.
 *
 * The amount is spread over them oldest first, and stops when it runs out —
 * a transfer that does not cover everything selected settles what it reaches
 * rather than failing, because that is what the money did.
 */
export async function saveBatchSettle(input: {
  reservationIds: number[];
  amount: number;
  desc?: string | null;
  reference?: string | null;
  adminId: number;
  adminName: string;
}) {
  const total = round(input.amount);
  if (!Number.isFinite(total) || total <= 0) throw AppError.badRequest("مبلغ نامعتبر است");
  if (input.reservationIds.length === 0) throw AppError.badRequest("رزروی انتخاب نشده است");

  const rows = await prisma.reservation.findMany({
    where: { id: { in: input.reservationIds } },
    orderBy: { startDate: "asc" },
    select: { id: true, hostShare: true, settledAmount: true, clearRemainder: true },
  });

  let left = total;
  const applied: { reservationId: number; amount: number }[] = [];

  for (const row of rows) {
    if (left <= 0) break;
    const remaining = remainderOf(row);
    if (remaining <= 0) continue;

    const take = Math.min(remaining, left);
    applied.push({ reservationId: row.id, amount: take });
    left = round(left - take);
  }

  if (applied.length === 0) throw AppError.badRequest("این رزروها مانده‌ای برای واریز ندارند");

  for (const item of applied) {
    await saveSettleInfo({
      reservationId: item.reservationId,
      amount: item.amount,
      type: "remainder",
      desc: input.desc,
      reference: input.reference,
      payWith: "shaba",
      adminId: input.adminId,
      adminName: input.adminName,
    });
  }

  return { settled: applied.length, applied, unallocated: round(left) };
}

/**
 * Overrides the remaining figure, with a reason.
 *
 * Logged as an ADJUSTMENT so the panel's transaction list shows it as a
 * correction rather than a payment. The amount recorded is the change, not
 * the new total: a log that says "set to 500,000" cannot be read back into
 * what it was before.
 */
export async function updateRemainder(input: {
  reservationId: number;
  amount: number;
  desc: string;
  adminId: number;
  adminName: string;
}) {
  const next = round(input.amount);
  if (!Number.isFinite(next) || next < 0) throw AppError.badRequest("مبلغ نامعتبر است");
  if (!input.desc?.trim()) throw AppError.badRequest("دلیل ویرایش لازم است");

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: { id: true, hostId: true, hostShare: true, settledAmount: true, clearRemainder: true },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const before = remainderOf(reservation);

  return prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservation.id },
      data: { clearRemainder: next },
    });

    return tx.hostDeposit.create({
      data: {
        hostId: reservation.hostId,
        reservationId: reservation.id,
        kind: "ADJUSTMENT",
        amount: round(next - before),
        description: input.desc.trim(),
        payerName: input.adminName || null,
        createdById: input.adminId,
      },
    });
  });
}

export async function saveSaleDescription(reservationId: number, desc: string) {
  return prisma.reservation.update({
    where: { id: reservationId },
    data: { salesDescription: desc },
    select: { id: true, salesDescription: true },
  });
}

/**
 * Edits a host's bank details from the panel.
 *
 * The same record the host edits from their own wallet page, which is the
 * point: finance correcting a mistyped shaba should fix it everywhere, not
 * keep a second copy that only the payout desk can see.
 */
export async function saveHostBankInfo(input: {
  hostId: number;
  card?: string | null;
  cardOwner?: string | null;
  shaba?: string | null;
  shabaOwner?: string | null;
}) {
  const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

  const card = digits(input.card);
  const shaba = digits(input.shaba);

  if (card && card.length !== 16) throw AppError.badRequest("شماره کارت باید ۱۶ رقم باشد");
  if (shaba && shaba.length !== 24) throw AppError.badRequest("شماره شبا باید ۲۴ رقم باشد");

  const data = {
    cardNumber: card || null,
    cardOwnerName: input.cardOwner?.trim() || null,
    shabaNumber: shaba || null,
    shabaOwnerName: input.shabaOwner?.trim() || null,
  };

  return prisma.bankAccount.upsert({
    where: { userId: input.hostId },
    create: { userId: input.hostId, ...data },
    update: data,
  });
}
