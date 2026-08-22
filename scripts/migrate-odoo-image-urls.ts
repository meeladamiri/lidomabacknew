// One-off migration: builds `legacy_image_redirects` — the map from legacy
// Odoo image URLs ("/web/image/product.image/<id>/image/<seo-name>.jpg",
// Google-Images-indexed via cdn.lidomatrip.com) to the migrated
// object-storage URLs.
//
// How the mapping works:
//   - Odoo stored image binaries via ir_attachment (res_model +
//     res_field='image' + res_id + store_fname).
//   - scripts/upload-images.js (run on the source server) uploaded each
//     filestore file to "migrated/<store_fname with '/' -> '-'>" — so the
//     target URL is derivable straight from store_fname.
//   - Only attachments whose derived URL actually exists in the target DB
//     (residence_images.url / rooms.image) are included — those are exactly
//     the files that were uploaded (published residences); everything else
//     would 301 to a 404, which is no better than not redirecting.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-image-urls.ts               # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-image-urls.ts --commit        # writes

import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
const BATCH = 1000;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface AttachmentRow {
  res_model: string;
  res_id: number;
  store_fname: string;
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);

  // 1) The set of URLs that actually exist in object storage (i.e. were
  //    referenced by migrated residences/rooms and therefore uploaded).
  const [imageRows, roomRows] = await Promise.all([
    targetPrisma.residenceImage.findMany({ select: { url: true } }),
    targetPrisma.room.findMany({ where: { image: { not: null } }, select: { image: true } }),
  ]);
  const validUrls = new Set<string>();
  for (const r of imageRows) validUrls.add(r.url);
  for (const r of roomRows) if (r.image) validUrls.add(r.image);
  console.log(`Valid uploaded URLs in target DB: ${validUrls.size}`);

  // Derive the storage base from any migrated URL ("…/migrated/xx-hash") —
  // the set also holds locally-uploaded "/uploads/…" files, skip those.
  const sampleUrl = [...validUrls].find((u) => u.includes("/migrated/"));
  if (!sampleUrl) throw new Error("no migrated/ URL found in target DB");
  const base = sampleUrl.slice(0, sampleUrl.indexOf("/migrated/"));
  console.log(`Storage base: ${base}`);

  // 2) Legacy attachments for gallery images and template main images.
  const attachments = await odoo.$queryRawUnsafe<AttachmentRow[]>(`
    SELECT res_model, res_id, store_fname
    FROM ir_attachment
    WHERE res_model IN ('product.image', 'product.template')
      AND res_field = 'image'
      AND store_fname IS NOT NULL
  `);
  console.log(`Fetched ${attachments.length} legacy image attachments.`);

  const rows: { model: string; odooId: number; url: string }[] = [];
  let skippedNotUploaded = 0;
  for (const a of attachments) {
    const url = `${base}/migrated/${a.store_fname.replace("/", "-")}`;
    if (!validUrls.has(url)) {
      skippedNotUploaded++;
      continue;
    }
    rows.push({ model: a.res_model, odooId: a.res_id, url });
  }
  console.log(`Redirectable: ${rows.length} (skipped — file never uploaded: ${skippedNotUploaded})`);
  rows.slice(0, 3).forEach((r) => console.log(`  ${r.model}/${r.odooId} -> ${r.url.slice(-40)}`));

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  let created = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await targetPrisma.legacyImageRedirect.createMany({
      data: rows.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    created += res.count;
  }
  console.log(`\nDone. Created ${created} (${rows.length - created} already existed).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await odoo.$disconnect();
    await targetPrisma.$disconnect();
  });
