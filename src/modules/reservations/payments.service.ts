import { Prisma, type ReservationPaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";

/**
 * پرداخت‌های مهمان.
 *
 * `Reservation.paidAmount` was a single number, so a booking settled in three
 * instalments could record the sum and nothing else — not when each arrived,
 * not how, not who took it. 9,445 of the bookings migrated from Odoo were paid
 * more than once, up to thirteen times, so this is the ordinary case rather
 * than an edge one.
 *
 * `paidAmount` stays, as the cached total of the payments still standing. Every
 * existing reader — the deposit panel, the cancellation refund, the
 * reservations list — keeps working without knowing this table exists.
 *
 * Nothing is deleted. A payment entered wrongly is voided with a reason and
 * stops counting; the row stays, because "we thought we had been paid on the
 * 3rd" is the fact a dispute turns on.
 */

const METHOD_LABEL: Record<ReservationPaymentMethod, string> = {
  GATEWAY: "درگاه پرداخت",
  CARD_TRANSFER: "کارت به کارت",
  BANK_TRANSFER: "واریز بانکی",
  CASH: "نقدی",
  WALLET: "کیف پول",
  OTHER: "سایر",
};

const fa = (n: number) => n.toLocaleString("fa-IR");

/**
 * Every booking made before this table existed carries a `paidAmount` and no
 * rows to explain it. Recomputing the total from an empty ledger would erase
 * it, so the first write to such a booking opens with the figure it already
 * had, marked for what it is.
 */
async function ensureOpeningBalance(tx: Prisma.TransactionClient, reservationId: number) {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: { paidAmount: true, createdAt: true },
  });
  if (!reservation || reservation.paidAmount <= 0) return;

  const existing = await tx.reservationPayment.count({ where: { reservationId } });
  if (existing > 0) return;

  await tx.reservationPayment.create({
    data: {
      reservationId,
      amount: reservation.paidAmount,
      method: "OTHER",
      paidAt: reservation.createdAt,
      note: "مبلغ پرداختی ثبت‌شده پیش از راه‌اندازی دفتر پرداخت‌ها",
      recordedByName: "سیستم",
    },
  });
}

/** Re-derives the cached totals from the ledger. */
async function recompute(tx: Prisma.TransactionClient, reservationId: number) {
  const [agg, reservation] = await Promise.all([
    tx.reservationPayment.aggregate({
      where: { reservationId, voidedAt: null },
      _sum: { amount: true },
    }),
    tx.reservation.findUnique({
      where: { id: reservationId },
      select: { totalAmount: true, guestCommission: true },
    }),
  ]);
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const paid = agg._sum.amount ?? 0;
  // What the guest owes is the rent plus the fee added on top for them —
  // the same sum the reservation page prints as «مبلغ کل جهت پرداختی».
  const due = reservation.totalAmount + (reservation.guestCommission ?? 0);

  await tx.reservation.update({
    where: { id: reservationId },
    data: { paidAmount: paid, remainingAmount: Math.max(due - paid, 0) },
  });

  return { paid, due, remaining: Math.max(due - paid, 0) };
}

export async function list(reservationId: number) {
  const [payments, reservation] = await Promise.all([
    prisma.reservationPayment.findMany({
      where: { reservationId },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
    }),
    prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { totalAmount: true, guestCommission: true, paidAmount: true },
    }),
  ]);
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  const due = reservation.totalAmount + (reservation.guestCommission ?? 0);
  const paid = payments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0);

  return {
    items: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      method_label: METHOD_LABEL[p.method],
      paid_at: p.paidAt,
      reference: p.reference,
      note: p.note,
      recorded_by: p.recordedByName,
      voided_at: p.voidedAt,
      voided_reason: p.voidedReason,
      created_at: p.createdAt,
    })),
    summary: {
      due,
      paid,
      remaining: Math.max(due - paid, 0),
      // A booking can legitimately be overpaid — a guest who transferred twice
      // — and hiding it behind a clamped remainder is how it stays unnoticed.
      overpaid: Math.max(paid - due, 0),
      // Bookings migrated from Odoo have a total but no ledger until the first
      // write, so the page can say why the list looks empty.
      ledger_started: payments.length > 0,
      stored_paid_amount: reservation.paidAmount,
    },
  };
}

export async function record(input: {
  reservationId: number;
  amount: number;
  method: ReservationPaymentMethod;
  paidAt: Date;
  reference?: string | null;
  note?: string | null;
  actorId: number;
}) {
  if (!(input.amount > 0)) throw AppError.badRequest("مبلغ پرداخت باید بیشتر از صفر باشد");

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: { id: true, reference: true, state: true },
  });
  if (!reservation) throw AppError.notFound("رزرو پیدا نشد");

  if (reservation.state === "CANCEL") {
    throw AppError.badRequest("برای رزرو لغوشده پرداخت ثبت نمی‌شود");
  }

  const actor = await prisma.user.findUnique({
    where: { id: input.actorId },
    select: { name: true, phone: true },
  });
  const actorName = actor?.name || actor?.phone || `ادمین #${input.actorId}`;

  const result = await prisma.$transaction(async (tx) => {
    await ensureOpeningBalance(tx, input.reservationId);

    const payment = await tx.reservationPayment.create({
      data: {
        reservationId: input.reservationId,
        amount: input.amount,
        method: input.method,
        paidAt: input.paidAt,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        recordedById: input.actorId,
        recordedByName: actorName,
      },
    });

    const totals = await recompute(tx, input.reservationId);
    return { payment, totals };
  });

  activity.log({
    kind: "FIELD_CHANGE",
    reservationId: input.reservationId,
    summary:
      `پرداخت ${fa(input.amount)} تومان ثبت شد (${METHOD_LABEL[input.method]})` +
      (input.reference ? ` · پیگیری ${input.reference}` : "") +
      ` — جمع پرداختی ${fa(result.totals.paid)} از ${fa(result.totals.due)} تومان`,
    details: { paymentId: result.payment.id, amount: input.amount, method: input.method } as never,
    actorId: input.actorId,
    source: "PAYMENT",
  });

  return result;
}

export async function voidPayment(input: {
  paymentId: number;
  reason: string;
  actorId: number;
}) {
  const reason = input.reason?.trim();
  if (!reason) throw AppError.badRequest("دلیل ابطال پرداخت الزامی است");

  const payment = await prisma.reservationPayment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, reservationId: true, amount: true, voidedAt: true, method: true },
  });
  if (!payment) throw AppError.notFound("پرداخت پیدا نشد");
  if (payment.voidedAt) throw AppError.badRequest("این پرداخت قبلاً باطل شده است");

  const result = await prisma.$transaction(async (tx) => {
    await tx.reservationPayment.update({
      where: { id: payment.id },
      data: { voidedAt: new Date(), voidedReason: reason, voidedById: input.actorId },
    });
    return recompute(tx, payment.reservationId);
  });

  activity.log({
    kind: "FIELD_CHANGE",
    reservationId: payment.reservationId,
    summary:
      `پرداخت ${fa(payment.amount)} تومان باطل شد — ${reason}` +
      ` · جمع پرداختی ${fa(result.paid)} از ${fa(result.due)} تومان`,
    details: { paymentId: payment.id, amount: payment.amount } as never,
    actorId: input.actorId,
    source: "PAYMENT",
  });

  return result;
}
