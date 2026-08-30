import { prisma } from "@/lib/prisma";

/**
 * Site-wide reservation money rules, and the arithmetic that uses them.
 *
 * The rules come from the Odoo system this replaced, read out of its own data
 * rather than assumed:
 *
 *   - `res_partner.x_commission` ("کمیسیون میزبان (درصد)") was 15 for 276,385
 *     hosts, with a few hundred negotiated to 10, 20, 5 or 0. So: one global
 *     rate, overridable per host.
 *   - `x_website_share` was that percentage of `x_total_amount`.
 *   - `x_vat_amount` was **10% of the commission**, not of the rent — 67,500
 *     on a 675,000 cut of a 4,500,000 booking, and the same ratio on every
 *     row checked. Charging VAT on the rent instead would be roughly ten
 *     times too much, so the base matters more than the rate does.
 *   - `x_actual_host_portion` = total − commission − VAT, which held on
 *     39,546 of the 43,939 confirmed bookings.
 *   - `x_user_commission` ("کارمزد (مهمان)") was a separate ~5% fee added on
 *     top of the rent for the guest, on 2,857 bookings. Off by default here.
 */

export interface ReservationRates {
  commissionPercent: number;
  vatPercent: number;
  guestCommissionPercent: number;
  releaseOnStartDate: boolean;
  minSettlement: number;
  approvalWindowMinutes: number;
  paymentWindowMinutes: number;
}

const DEFAULTS: ReservationRates = {
  commissionPercent: 15,
  vatPercent: 10,
  guestCommissionPercent: 0,
  releaseOnStartDate: true,
  minSettlement: 50_000,
  approvalWindowMinutes: 120,
  paymentWindowMinutes: 120,
};

// Read on every booking and on every settlement screen, changed a few times a
// year. Cached for a minute so a burst of bookings does not each pay for the
// same row, and so a rate change still takes effect without a deploy.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: ReservationRates } | null = null;

export async function getSettings(): Promise<ReservationRates> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const row = await prisma.reservationSettings.findUnique({ where: { id: 1 } });
  const value: ReservationRates = row
    ? {
        commissionPercent: row.commissionPercent,
        vatPercent: row.vatPercent,
        guestCommissionPercent: row.guestCommissionPercent,
        releaseOnStartDate: row.releaseOnStartDate,
        minSettlement: row.minSettlement,
        approvalWindowMinutes: row.approvalWindowMinutes,
        paymentWindowMinutes: row.paymentWindowMinutes,
      }
    : DEFAULTS;

  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(input: Partial<ReservationRates>) {
  const row = await prisma.reservationSettings.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULTS, ...input },
    update: input,
  });
  cache = null;
  return row;
}

/** A deadline `n` minutes from now, which is how both windows are set. */
export function deadlineIn(minutes: number, from = new Date()) {
  return new Date(from.getTime() + minutes * 60_000);
}

/**
 * How many hosts have been given their own rate.
 *
 * Shown next to the global rate because changing it does nothing for them, and
 * that is much better learned before saving than from a host's invoice.
 */
export async function countHostOverrides() {
  return prisma.user.count({ where: { commissionPercent: { not: null } } });
}

/** Percentages are set by people typing into a form, so they are clamped. */
const pct = (n: number) => Math.min(100, Math.max(0, n));

// Money is rounded to the toman. Sub-toman fractions in a ledger are noise
// that eventually shows up as a balance nobody can reconcile.
const toman = (n: number) => Math.round(n);

export interface Breakdown {
  /** مبلغ کل اجاره */
  totalAmount: number;
  /** کارمزد میزبان وبسایت — the site's cut, taken out of the host's money */
  websiteShare: number;
  /** ارزش افزوده — VAT on that cut */
  vatAmount: number;
  /** کارمزد مهمان وبسایت — added on top of the rent for the guest */
  guestCommission: number;
  /** مقدار اصلی سهم میزبان بابت کل رزرو */
  hostShare: number;
  /** What the guest owes in total: rent + guest fee */
  guestPayable: number;
  commissionPercent: number;
  vatPercent: number;
  guestCommissionPercent: number;
}

/**
 * Splits a booking's rent into the four amounts that matter.
 *
 * Every figure is derived here and nowhere else. The reservation stores the
 * results, so a later rate change cannot restate what a host was already owed.
 */
export function computeBreakdown(
  totalAmount: number,
  rates: {
    commissionPercent: number;
    vatPercent: number;
    guestCommissionPercent: number;
  }
): Breakdown {
  const commissionPercent = pct(rates.commissionPercent);
  const vatPercent = pct(rates.vatPercent);
  const guestCommissionPercent = pct(rates.guestCommissionPercent);

  const websiteShare = toman((totalAmount * commissionPercent) / 100);
  const vatAmount = toman((websiteShare * vatPercent) / 100);
  const guestCommission = toman((totalAmount * guestCommissionPercent) / 100);

  return {
    totalAmount,
    websiteShare,
    vatAmount,
    guestCommission,
    // Subtraction, not its own percentage: the host gets what is left, so the
    // four numbers always add back up to the rent.
    hostShare: totalAmount - websiteShare - vatAmount,
    guestPayable: totalAmount + guestCommission,
    commissionPercent,
    vatPercent,
    guestCommissionPercent,
  };
}

/**
 * The commission rate for one host: their own if they have been given one,
 * otherwise the site's.
 *
 * Zero is a real rate — a host who negotiated no commission at all — so this
 * checks for null rather than falsiness.
 */
export async function ratesForHost(hostId: number) {
  const [settings, host] = await Promise.all([
    getSettings(),
    prisma.user.findUnique({ where: { id: hostId }, select: { commissionPercent: true } }),
  ]);

  return {
    ...settings,
    commissionPercent:
      host?.commissionPercent != null ? host.commissionPercent : settings.commissionPercent,
    /** True when this host's rate is their own rather than the site default. */
    isHostSpecific: host?.commissionPercent != null,
  };
}

/** The full breakdown for a booking that has not been created yet. */
export async function breakdownForHost(hostId: number, totalAmount: number) {
  return computeBreakdown(totalAmount, await ratesForHost(hostId));
}
