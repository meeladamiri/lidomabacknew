import { createRedis } from "@/lib/cache";
import { env } from "@/config/env";

/**
 * The in-process scheduler.
 *
 * Deliberately not a cron library and not a platform cron. A dependency would
 * add a parser for an expression format nobody here needs — every job in this
 * project runs "every N minutes" — and a platform cron would put the schedule
 * somewhere the repository cannot see, which is how a job quietly stops
 * existing after a migration between hosts.
 *
 * What it does provide is the three things a naive `setInterval` gets wrong:
 *
 *   1. **Overlap.** A run that outlasts its interval must not be joined by the
 *      next one. Two sweeps releasing the same held balance at once is the
 *      exact race the wallet's transaction guard exists to catch, and relying
 *      on that guard to catch it every time is not a design.
 *   2. **Failure.** A job that throws must not take the process with it, and
 *      must not stop the schedule either.
 *   3. **More than one instance.** Liara runs one today. The day it runs two,
 *      both would sweep. A short Redis lock makes that a no-op rather than a
 *      double payout, and costs one SET when Redis is there.
 *
 * Without Redis the lock is skipped and the scheduler still runs — a single
 * instance with no cache is the local development setup, and refusing to
 * schedule there would mean the code that matters never runs before deploy.
 */

export interface Job {
  /** Stable identifier. Used as the Redis lock key, so renaming one releases the lock early. */
  name: string;
  /** How often to run, in minutes. */
  everyMinutes: number;
  /**
   * Minutes to wait before the first run. Boot is the worst moment to add
   * database work to: the process is also serving its first requests and
   * warming its connection pool.
   */
  delayMinutes?: number;
  run: () => Promise<unknown>;
}

interface JobState {
  job: Job;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  runs: number;
  failures: number;
  skipped: number;
  lastResult: unknown;
}

const states = new Map<string, JobState>();
let lockRedis: ReturnType<typeof createRedis> = null;
let started = false;

/**
 * Takes a short lock so only one instance runs a job in a given window.
 *
 * The TTL is the interval, not the expected duration: a lock that outlives the
 * window would skip the next run, and one that expires early lets a second
 * instance start while the first is still working. Held only for the window,
 * released implicitly by expiry — never deleted on completion, because a
 * crashed run should still hold its slot until the window is over rather than
 * inviting an immediate retry from another instance.
 */
async function acquire(name: string, ttlSeconds: number): Promise<boolean> {
  if (!lockRedis) return true;

  try {
    const res = await lockRedis.set(`scheduler:lock:${name}`, process.pid.toString(), "EX", ttlSeconds, "NX");
    return res === "OK";
  } catch {
    // Redis is down. Running is the lesser risk: the jobs here are idempotent,
    // and not running them means hosts are not paid.
    return true;
  }
}

async function tick(state: JobState) {
  const { job } = state;

  // A previous run is still going. Skipping is right rather than queueing:
  // these jobs sweep "everything that has matured", so the next run covers
  // whatever this one is still working through.
  if (state.running) {
    state.skipped++;
    return;
  }

  const ttl = Math.max(Math.round(job.everyMinutes * 60) - 5, 30);
  if (!(await acquire(job.name, ttl))) {
    state.skipped++;
    return;
  }

  state.running = true;
  state.lastRunAt = new Date();
  state.runs++;

  try {
    state.lastResult = await job.run();
    state.lastOkAt = new Date();
    state.lastError = null;
  } catch (error) {
    state.failures++;
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler:${job.name}] failed: ${state.lastError}`);
  } finally {
    state.running = false;
  }
}

export function register(job: Job) {
  if (states.has(job.name)) throw new Error(`duplicate scheduler job: ${job.name}`);
  states.set(job.name, {
    job,
    timer: null,
    running: false,
    lastRunAt: null,
    lastOkAt: null,
    lastError: null,
    runs: 0,
    failures: 0,
    skipped: 0,
    lastResult: null,
  });
}

export function startScheduler() {
  if (started) return;
  started = true;

  if (!env.scheduler.enabled) {
    console.info("[scheduler] disabled (SCHEDULER_ENABLED=false)");
    return;
  }

  lockRedis = createRedis("scheduler");

  for (const state of states.values()) {
    const { job } = state;
    const everyMs = job.everyMinutes * 60_000;
    const delayMs = (job.delayMinutes ?? 1) * 60_000;

    setTimeout(() => {
      void tick(state);
      state.timer = setInterval(() => void tick(state), everyMs);
      // Node keeps the process alive for a pending interval; a scheduler must
      // not be the reason a container refuses to exit.
      state.timer.unref?.();
    }, delayMs).unref?.();
  }

  console.info(
    `[scheduler] started with ${states.size} job(s): ${[...states.keys()].join(", ")}`
  );
}

export function stopScheduler() {
  for (const state of states.values()) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }
  started = false;
}

/** For the admin panel and /health: what is scheduled and how it last went. */
export function schedulerStatus() {
  return {
    enabled: env.scheduler.enabled,
    started,
    locking: !!lockRedis,
    jobs: [...states.values()].map((s) => ({
      name: s.job.name,
      everyMinutes: s.job.everyMinutes,
      running: s.running,
      runs: s.runs,
      failures: s.failures,
      skipped: s.skipped,
      lastRunAt: s.lastRunAt,
      lastOkAt: s.lastOkAt,
      lastError: s.lastError,
      lastResult: s.lastResult,
    })),
  };
}

/**
 * Runs one job now, from the admin panel, ignoring its schedule.
 *
 * Bypasses the lock: an admin pressing the button has decided, and the jobs
 * are idempotent. It still refuses while the job is already running, which is
 * the case the button would actually create.
 */
export async function runJobNow(name: string) {
  const state = states.get(name);
  if (!state) throw new Error(`unknown job: ${name}`);
  if (state.running) throw new Error("این کار همین الان در حال اجراست");

  state.running = true;
  state.lastRunAt = new Date();
  state.runs++;
  try {
    state.lastResult = await state.job.run();
    state.lastOkAt = new Date();
    state.lastError = null;
    return state.lastResult;
  } catch (error) {
    state.failures++;
    state.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.running = false;
  }
}
