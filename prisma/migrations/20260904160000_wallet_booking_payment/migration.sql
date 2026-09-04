-- "کیف پول" stopped being a payment method with no effect.
--
-- ReservationPaymentMethod.WALLET was always a selectable option in the
-- record-payment form, but nothing behind it ever touched the guest's own
-- Wallet.balance — recording one just wrote a ReservationPayment row, same
-- as CARD_TRANSFER or CASH. This value lets that debit (and, on voiding the
-- payment, its reversal) be logged under its own kind rather than folded into
-- ADJUSTMENT, which already means something else (an admin's own correction,
-- e.g. reverseHostIncome). Purely additive — no existing row's kind changes.
ALTER TYPE "WalletTransactionKind" ADD VALUE IF NOT EXISTS 'BOOKING_PAYMENT';
