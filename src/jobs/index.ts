import { register } from "@/lib/scheduler";
import { env } from "@/config/env";
import { releaseMaturedEarnings } from "@/modules/admin/admin.service";
import { expireOverdue } from "@/modules/reservations/expiry.service";

/**
 * Everything that runs on a clock.
 *
 * One file, so "what happens without anyone pressing a button" is answerable
 * by reading a single screen.
 */

/**
 * Moves host earnings from held to withdrawable once a stay has started.
 *
 * The sweep itself takes 200 bookings at a time, which is a sensible query and
 * a poor job: after a quiet weekend, or the first run after this shipped, the
 * backlog is larger than one page and the rest would wait an hour per page.
 * So it drains, with a cap — an unbounded loop against a growing table is how
 * a scheduled job turns into an outage.
 */
async function releaseMatured() {
  const MAX_PAGES = 25; // 5,000 bookings in one pass; a backlog beyond that can wait an hour
  let checked = 0;
  let released = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const result = await releaseMaturedEarnings();
    checked += result.checked;
    released += result.released;
    pages++;

    // A page that released nothing means everything left is already released
    // or cannot be — either way, going round again changes nothing.
    if (result.released === 0) break;
  }

  if (released > 0) {
    console.info(`[job:release-matured] released ${released} of ${checked} checked`);
  }

  return { checked, released, pages, cappedOut: pages >= MAX_PAGES };
}

/**
 * Expires bookings nobody acted on, and puts their dates back on sale.
 *
 * Runs far more often than the maturity sweep. A deadline is measured in
 * minutes, so an hourly job would turn a two-hour window into up to three —
 * and the dates stay unsellable for the whole difference.
 */
async function expireBookings() {
  const result = await expireOverdue();
  if (result.expired > 0) {
    console.info(`[job:expire-bookings] expired ${result.expired} of ${result.checked} due`);
  }
  return result;
}

export function registerJobs() {
  register({
    name: "release-matured",
    everyMinutes: env.scheduler.releaseEveryMinutes,
    // Maturity is measured in days, so the first sweep can wait a couple of
    // minutes and let the process finish booting.
    delayMinutes: 2,
    run: releaseMatured,
  });

  register({
    name: "expire-bookings",
    everyMinutes: env.scheduler.expireEveryMinutes,
    delayMinutes: 1,
    run: expireBookings,
  });
}
