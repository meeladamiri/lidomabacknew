// Fills `location.imageUrl` — the photo shown for a city in the destination
// picker and the home page's popular-destination rail. All 565 locations had
// it null; the location migration never carried images.
//
// WHERE THE IMAGES ACTUALLY ARE
//
// Odoo keeps two unrelated sets, and the obvious one is the wrong one:
//
//   product_public_category.x_suggest_image   31 rows, 2-3 KB WEBP thumbnails
//   ir_attachment (res_field='image')        405 rows, 294-418 KB photos
//
// The second set covers 402 of our 565 locations, but its rows have
// db_datas NULL and store_fname set: the bytes live on the old Odoo server's
// filestore, not in the database, so they cannot be read over the SQL
// connection at all. They are served publicly, though, which is what this
// script uses:
//
//   https://lidomatrip.com/web/image/product.public.category/<odooId>/image
//
// That means this script depends on the old site still being up. It is the only
// way to reach these files short of shell access to that server, and it is a
// reason to run this before lidomatrip.com is retired.
//
// Idempotent: keys are content-hashed, and a location whose imageUrl already
// points at our bucket is skipped, so re-running costs only the HEAD-like
// checks it needs.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-location-images.ts           # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-location-images.ts --commit  # writes
//   ... --limit 20        stop after N locations (useful for a first pass)

import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/prisma";
import { env } from "@/config/env";

const COMMIT = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const ODOO_ORIGIN = process.env.ODOO_ORIGIN ?? "https://lidomatrip.com";

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();
const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

const storageReady = !!(
  env.objectStorage.endpoint &&
  env.objectStorage.bucket &&
  env.objectStorage.accessKey &&
  env.objectStorage.secretKey
);

const s3 = storageReady
  ? new S3Client({
      endpoint: `https://${env.objectStorage.endpoint}`,
      region: "us-east-1",
      credentials: {
        accessKeyId: env.objectStorage.accessKey!,
        secretAccessKey: env.objectStorage.secretKey!,
      },
      forcePathStyle: false,
    })
  : null;

function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: "png", mime: "image/png" };
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
    return { ext: "webp", mime: "image/webp" };
  return null;
}

/** Real pixel size, so a placeholder does not get promoted to a city photo. */
function dimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

// Below this, it is an icon or a placeholder, not a photograph of a city.
const MIN_WIDTH = 200;
const MIN_BYTES = 8 * 1024;

async function main() {
  console.log(`حالت: ${COMMIT ? "COMMIT (آپلود و نوشتن)" : "DRY RUN (بدون هیچ نوشتنی)"}`);
  console.log(`منبع تصویر: ${ODOO_ORIGIN}\n`);
  if (COMMIT && !storageReady) {
    throw new Error("برای آپلود، متغیرهای LIARA_* لازم‌اند.");
  }

  const locations = await prisma.location.findMany({
    where: { odooId: { not: null } },
    select: { id: true, name: true, type: true, odooId: true, imageUrl: true },
    orderBy: { id: "asc" },
  });

  const odooIds = locations.map((l) => l.odooId!) as number[];
  const withImage = new Set(
    (
      await odoo.$queryRawUnsafe<{ res_id: number }[]>(
        `SELECT DISTINCT res_id FROM ir_attachment
         WHERE res_model = 'product.public.category' AND res_field = 'image'
           AND res_id = ANY($1::int[])`,
        odooIds
      )
    ).map((r) => Number(r.res_id))
  );

  const targets = locations
    .filter((l) => withImage.has(l.odooId!) && !l.imageUrl)
    .slice(0, LIMIT);

  console.log(`مکان‌های دارای odooId: ${locations.length}`);
  console.log(`از این‌ها تصویر در Odoo دارند: ${withImage.size}`);
  console.log(`از قبل imageUrl دارند: ${locations.filter((l) => l.imageUrl).length}`);
  console.log(`برای پردازش: ${targets.length}\n`);

  let ok = 0, skippedSmall = 0, failed = 0, bytes = 0;

  for (const loc of targets) {
    const src = `${ODOO_ORIGIN}/web/image/product.public.category/${loc.odooId}/image`;
    let buf: Buffer;
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.log(`  ✗ ${loc.name} — HTTP ${res.status}`); failed++; continue; }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      console.log(`  ✗ ${loc.name} — ${e.message}`); failed++; continue;
    }

    const kind = sniffImage(buf);
    const dim = dimensions(buf);
    if (!kind || buf.length < MIN_BYTES || (dim && dim.w < MIN_WIDTH)) {
      console.log(
        `  – ${loc.name} — رد شد (${(buf.length / 1024).toFixed(0)}KB${dim ? `, ${dim.w}×${dim.h}` : ""})`
      );
      skippedSmall++; continue;
    }

    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
    const key = `locations/${loc.odooId}-${hash}.${kind.ext}`;
    const url = `https://${env.objectStorage.bucket}.${env.objectStorage.endpoint}/${key}`;

    if (!COMMIT) {
      console.log(
        `  → ${loc.name.padEnd(14)} ${(buf.length / 1024).toFixed(0).padStart(4)}KB` +
          `${dim ? ` ${dim.w}×${dim.h}` : ""}  ${key}`
      );
      ok++; bytes += buf.length; continue;
    }

    await s3!.send(
      new PutObjectCommand({
        Bucket: env.objectStorage.bucket!,
        Key: key,
        Body: buf,
        ContentType: kind.mime,
        ACL: "public-read",
      })
    );
    await prisma.location.update({ where: { id: loc.id }, data: { imageUrl: url } });
    console.log(`  ✓ ${loc.name.padEnd(14)} ${(buf.length / 1024).toFixed(0).padStart(4)}KB  ${key}`);
    ok++; bytes += buf.length;
  }

  console.log(`\nخلاصه: ${ok} ${COMMIT ? "انجام شد" : "آماده"} · ${skippedSmall} خیلی کوچک · ${failed} ناموفق`);
  console.log(`حجم: ${(bytes / 1048576).toFixed(1)} MB`);
  if (!COMMIT) console.log("\nهیچ چیزی نوشته نشد. برای اجرا: --commit");
}

main().finally(async () => {
  await odoo.$disconnect();
  await prisma.$disconnect();
});
