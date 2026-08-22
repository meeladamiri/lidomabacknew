// One-off backfill: sets `avatarUrl` on already-migrated host users, using
// the map produced by scripts/upload-host-avatars.js (run on the Odoo
// source server — see that file for why avatars are filtered to ~2,027
// likely-real photos, excluding Odoo's auto-generated default avatars).
//
// Usage:
//   npx tsx scripts/backfill-host-avatars.ts               # dry run
//   npx tsx scripts/backfill-host-avatars.ts --commit        # writes

import fs from "fs";
import { prisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const MAP_PATH = "scripts/host-avatar-map.json";

interface AvatarEntry {
  url: string;
  phone: string | null;
  mobile: string | null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  const map: Record<string, AvatarEntry> = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const entries = Object.values(map);
  console.log(`Loaded ${entries.length} uploaded avatars.`);

  let updated = 0;
  let alreadySet = 0;
  let noUser = 0;
  let noPhone = 0;

  for (const entry of entries) {
    const phone = normalizePhone(entry.mobile) ?? normalizePhone(entry.phone);
    if (!phone) {
      noPhone++;
      continue;
    }
    const user = await prisma.user.findUnique({ where: { phone }, select: { id: true, avatarUrl: true } });
    if (!user) {
      noUser++;
      continue;
    }
    if (user.avatarUrl) {
      alreadySet++;
      continue;
    }
    if (COMMIT) {
      await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: entry.url } });
    }
    updated++;
  }

  console.log(`\n${COMMIT ? "Updated" : "Would update"}: ${updated}`);
  console.log(`Already had an avatar (not overwritten): ${alreadySet}`);
  console.log(`No migrated user for this phone: ${noUser}`);
  console.log(`No usable phone on the Odoo side: ${noPhone}`);

  if (!COMMIT) console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
  else console.log("\nDone.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
