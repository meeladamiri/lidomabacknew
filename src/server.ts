import { buildApp } from "@/app";
import { env } from "@/config/env";
import { prisma } from "@/lib/prisma";

const app = buildApp();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[lidoma-backend] listening on port ${env.port} (${env.nodeEnv})`);
});

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[lidoma-backend] received ${signal}, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
