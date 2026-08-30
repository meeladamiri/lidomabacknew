import { buildApp } from "@/app";
import { env } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { registerJobs } from "@/jobs";
import { startScheduler, stopScheduler } from "@/lib/scheduler";

const app = buildApp();

// Registered here rather than in buildApp: the tests and any script that
// imports the app should not start background work that writes to the wallet.
registerJobs();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[lidoma-backend] listening on port ${env.port} (${env.nodeEnv})`);
  startScheduler();
});

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[lidoma-backend] received ${signal}, shutting down...`);
  stopScheduler();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
