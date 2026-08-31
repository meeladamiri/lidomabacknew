import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/**
 * آمار اقامتگاه — one listing, or every listing of one host.
 *
 * The same numbers answer both the panel's «آمار اقامتگاه» tab and the host's
 * own statistics page, so they are computed once here rather than twice with
 * two definitions of "income" that quietly disagree.
 *
 * ## What the numbers mean, and why they are grouped this way
 *
 * **Reservations** are counted by what actually happened to them, not by one
 * "approved / rejected" split. The old host page collapsed CANCEL into
 * "رد شده", which reads as "the host declined" when it usually means the guest
 * cancelled — two different facts with two different consequences for the
 * host. They are separate here.
 *
 * **Income** is the host's share, falling back to the total on rows migrated
 * before the split was recorded. It counts DONE only: money that has actually
 * been earned, not money that a pending booking might become.
 *
 * **Views** start from the day the counter shipped. See `ResidenceView` — no
 * view has ever been recorded before that, so the earlier months are honestly
 * absent rather than drawn as zero.
 */

/** A month bucket, keyed `YYYY-MM`, oldest first. */
export interface MonthPoint {
  month: string;
  nights: number;
  income: number;
  reservations: number;
  views: number;
}

/** A day bucket, keyed `YYYY-MM-DD`, oldest first. */
export interface DayPoint {
  date: string;
  nights: number;
  views: number;
}

/**
 * Iran is UTC+3:30 and has had no DST since 2022.
 *
 * Everything here is a *calendar day in Tehran*, not a UTC day. Using UTC
 * would file every visit between midnight and 03:30 local under the previous
 * day — which is real traffic, and exactly the hours a host browsing their own
 * listing at night would generate and then not find on the chart.
 *
 * The shift is applied to the timestamp and the result read in UTC, so the
 * same function names the day for both the counter and the buckets it lands
 * in. Those two must agree: if the writer said "today" in Tehran and the
 * reader listed days in UTC, today's views would fall outside the window.
 */
const IRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

const shifted = (d: Date | number) => new Date((typeof d === "number" ? d : d.getTime()) + IRAN_OFFSET_MS);

/** The Tehran calendar day of an instant, as `YYYY-MM-DD`. */
const iso = (d: Date) => shifted(d).toISOString().slice(0, 10);

/** The Tehran calendar month of an instant, as `YYYY-MM`. */
const monthKey = (d: Date) => shifted(d).toISOString().slice(0, 7);

/**
 * A stored `@db.Date` comes back as midnight UTC of the day it names, so it
 * must NOT be shifted again — it is already a day, not an instant.
 */
const storedDay = (d: Date) => d.toISOString().slice(0, 10);

/** The last `n` months as `YYYY-MM`, oldest first, including this one. */
function lastMonths(n: number): string[] {
  const out: string[] = [];
  const now = shifted(Date.now());
  for (let i = n - 1; i >= 0; i--) {
    out.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7)
    );
  }
  return out;
}

/** The last `n` days as `YYYY-MM-DD`, oldest first, including today. */
function lastDays(n: number): string[] {
  const out: string[] = [];
  const today = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    out.push(iso(new Date(today - i * 86_400_000)));
  }
  return out;
}

export interface StatsScope {
  /** One listing. Mutually exclusive with `hostId`. */
  residenceId?: number;
  /** Every listing of one host. */
  hostId?: number;
}

export async function getStats(scope: StatsScope) {
  if (!scope.residenceId && !scope.hostId) {
    throw AppError.badRequest("محدوده‌ی آمار مشخص نیست");
  }

  const reservationWhere = {
    ...(scope.residenceId ? { residenceId: scope.residenceId } : {}),
    ...(scope.hostId ? { hostId: scope.hostId } : {}),
  };

  const residenceWhere = scope.residenceId
    ? { id: scope.residenceId }
    : { hostId: scope.hostId! };

  const months = lastMonths(12);
  const days = lastDays(30);
  // The month window is inclusive of its first bucket, so it starts at that
  // boundary; the daily window is a subset of it and needs no query of its own.
  const monthFrom = new Date(months[0] + "-01T00:00:00.000Z");

  const [byState, reviewAgg, reviewSpread, favourites, residenceIds, nightRows, viewRows] =
    await Promise.all([
      prisma.reservation.groupBy({
        by: ["state"],
        where: reservationWhere,
        _count: true,
      }),

      prisma.review.aggregate({
        where: scope.residenceId
          ? { residenceId: scope.residenceId }
          : { residence: { hostId: scope.hostId! } },
        _count: true,
        _avg: {
          averageRating: true,
          cleaning: true,
          location: true,
          quality: true,
          integrity: true,
          greeting: true,
          delivery: true,
        },
      }),

      // The 1..5 histogram, so "۴٫۵ average" can be read against how it was
      // reached — twenty fives and four ones is not the same listing as
      // twenty-four fours.
      prisma.review.groupBy({
        by: ["averageRating"],
        where: scope.residenceId
          ? { residenceId: scope.residenceId }
          : { residence: { hostId: scope.hostId! } },
        _count: true,
      }),

      prisma.favourite.count({
        where: scope.residenceId
          ? { residenceId: scope.residenceId }
          : { residence: { hostId: scope.hostId! } },
      }),

      prisma.residence.findMany({ where: residenceWhere, select: { id: true } }),

      // Every booking that touches the 12-month window. Bucketed in JS rather
      // than SQL because a stay spans months and the nights belong to the
      // months they fall in, not to the month the booking was made.
      prisma.reservation.findMany({
        where: {
          ...reservationWhere,
          state: { in: ["SECOND_PAYMENT", "DONE"] },
          endDate: { gte: monthFrom },
        },
        select: {
          startDate: true,
          endDate: true,
          daysCount: true,
          hostShare: true,
          totalAmount: true,
        },
      }),

      prisma.residenceView.findMany({
        where: { residence: residenceWhere, date: { gte: monthFrom } },
        select: { date: true, count: true },
      }),
    ]);

  const stateCount = (state: string) =>
    byState.find((r) => r.state === state)?._count ?? 0;

  // ---- time series ----------------------------------------------------

  const monthBuckets = new Map<string, MonthPoint>(
    months.map((m) => [m, { month: m, nights: 0, income: 0, reservations: 0, views: 0 }])
  );
  const dayBuckets = new Map<string, DayPoint>(
    days.map((d) => [d, { date: d, nights: 0, views: 0 }])
  );

  for (const r of nightRows) {
    const nights = Math.max(1, r.daysCount);
    // Per-night value, so a stay straddling a month boundary puts its money
    // where its nights are instead of all of it in the month it started.
    const perNight = (r.hostShare ?? r.totalAmount ?? 0) / nights;

    const bookedMonths = new Set<string>();
    for (let i = 0; i < nights; i++) {
      const night = new Date(r.startDate.getTime() + i * 86_400_000);
      const dk = storedDay(night);
      const mk = dk.slice(0, 7);

      const month = monthBuckets.get(mk);
      if (month) {
        month.nights += 1;
        month.income += perNight;
        bookedMonths.add(mk);
      }
      const day = dayBuckets.get(dk);
      if (day) day.nights += 1;
    }
    // A booking counts once per month it occupies, not once per night.
    for (const mk of bookedMonths) {
      const month = monthBuckets.get(mk);
      if (month) month.reservations += 1;
    }
  }

  for (const v of viewRows) {
    const dk = storedDay(v.date);
    const mk = dk.slice(0, 7);
    const month = monthBuckets.get(mk);
    if (month) month.views += v.count;
    const day = dayBuckets.get(dk);
    if (day) day.views += v.count;
  }

  for (const m of monthBuckets.values()) m.income = Math.round(m.income);

  // ---- lifetime totals ------------------------------------------------

  const doneAgg = await prisma.reservation.aggregate({
    where: { ...reservationWhere, state: "DONE" },
    _sum: { daysCount: true, hostShare: true, totalAmount: true },
    _count: true,
  });

  // hostShare is null on rows migrated before the split was recorded, so the
  // total is not simply SUM(hostShare) — those rows fall back to the total.
  const missingShare = await prisma.reservation.aggregate({
    where: { ...reservationWhere, state: "DONE", hostShare: null },
    _sum: { totalAmount: true },
  });

  const totalIncome =
    (doneAgg._sum.hostShare ?? 0) + (missingShare._sum.totalAmount ?? 0);

  // Months the listing actually earned in — dividing by 12 would report a
  // listing that was live for two months as having four bad ones.
  const earningMonths = [...monthBuckets.values()].filter((m) => m.income > 0).length;

  const spread: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const row of reviewSpread) {
    const star = String(Math.max(1, Math.min(5, Math.round(row.averageRating))));
    spread[star] += row._count;
  }

  const viewsTotal = viewRows.reduce((s, v) => s + v.count, 0);
  const trackingSince = await firstViewDate();

  return {
    scope: scope.residenceId ? "residence" : "host",
    residences_count: residenceIds.length,

    reservations: {
      total: byState.reduce((s, r) => s + r._count, 0),
      // «در انتظار تایید میزبان» — still waiting on the host.
      pending: stateCount("HOST_APPROVAL"),
      // Accepted and moving: paid the deposit, or completed.
      confirmed: stateCount("SECOND_PAYMENT") + stateCount("DONE"),
      done: stateCount("DONE"),
      cancelled: stateCount("CANCEL"),
      rejected: stateCount("REJECTED"),
      expired: stateCount("EXPIRED"),
      draft: stateCount("DRAFT"),
    },

    nights: {
      total: doneAgg._sum.daysCount ?? 0,
      last_year: [...monthBuckets.values()].reduce((s, m) => s + m.nights, 0),
      last_month: [...dayBuckets.values()].reduce((s, d) => s + d.nights, 0),
    },

    income: {
      total: totalIncome,
      monthly_average: earningMonths > 0
        ? Math.round(
            [...monthBuckets.values()].reduce((s, m) => s + m.income, 0) / earningMonths
          )
        : 0,
      last_year: [...monthBuckets.values()].reduce((s, m) => s + m.income, 0),
    },

    reviews: {
      count: reviewAgg._count,
      average: round1(reviewAgg._avg.averageRating),
      cleaning: round1(reviewAgg._avg.cleaning),
      location: round1(reviewAgg._avg.location),
      quality: round1(reviewAgg._avg.quality),
      integrity: round1(reviewAgg._avg.integrity),
      greeting: round1(reviewAgg._avg.greeting),
      delivery: round1(reviewAgg._avg.delivery),
      spread,
    },

    favourites,

    views: {
      last_year: viewsTotal,
      last_month: [...dayBuckets.values()].reduce((s, d) => s + d.views, 0),
      // The panel needs to say "no data yet" rather than "zero visitors".
      tracking_since: trackingSince,
    },

    monthly: [...monthBuckets.values()],
    daily: [...dayBuckets.values()],
  };
}

function round1(v: number | null): number {
  return v == null ? 0 : Math.round(v * 10) / 10;
}

/**
 * The oldest day any view was recorded on, anywhere.
 *
 * Not per-listing: a listing with no views of its own still wants to say
 * "counting started on X" rather than imply nobody has ever opened it. Null
 * until the first view lands.
 */
async function firstViewDate(): Promise<string | null> {
  const first = await prisma.residenceView.findFirst({
    orderBy: { date: "asc" },
    select: { date: true },
  });
  return first ? storedDay(first.date) : null;
}

/**
 * Records one page view.
 *
 * Fire-and-forget, like the notification hooks: a counter that failed is a
 * bug to fix, never a reason for a listing's page to fail to render. The
 * upsert is on (residence, day), so this is one statement per render rather
 * than a row that accumulates forever.
 */
export function recordView(residenceId: number): void {
  // The Tehran day, stored as midnight UTC of that day — which is how
  // Postgres hands a DATE column back, so writer and reader agree.
  const today = new Date(iso(new Date()) + "T00:00:00.000Z");
  void prisma.residenceView
    .upsert({
      where: { residenceId_date: { residenceId, date: today } },
      create: { residenceId, date: today, count: 1 },
      update: { count: { increment: 1 } },
    })
    .catch((error) => {
      console.warn(
        `[views] residence ${residenceId} not counted:`,
        error instanceof Error ? error.message : error
      );
    });
}
