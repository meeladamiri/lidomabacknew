// Carries the ownership and identity documents over from Odoo.
//
// The panel's «مدرک مالکیت» tab reads three columns on `residences`, and all
// three are effectively empty — 0 deeds, 1 host ID card, 0 owner cards across
// 9,574 listings. The migration never brought them.
//
// Odoo has them, as base64 in three columns on `product_template`:
//
//   x_residence_document    1,277 rows   سند / مدرک مالکیت
//   x_host_national_card    1,649 rows   کارت ملی میزبان
//   x_owner_national_card     213 rows   کارت ملی مالک
//
// Unlike the location images, these bytes really are in the database — no
// dependency on the old site still being up.
//
// ## These are identity documents
//
// National ID cards and property deeds. That shapes three decisions here:
//
//   • **Keys are random, not derived from the listing id.** A predictable key
//     on a public bucket is an enumerable one, and "guess the URL, read
//     someone's national ID" is not a thing to ship. They are still
//     unauthenticated URLs — the bucket is public — so this is obscurity, not
//     security. Worth saying plainly: making them properly private needs
//     signed URLs, which is a separate change to how the panel loads them.
//   • **Nothing is logged that identifies a person.** Progress prints listing
//     ids and byte counts, never a name, a national number, or a URL.
//   • **Failures are skipped, never guessed at.** A row whose bytes will not
//     decode is reported and left alone; there is no "best effort" repair that
//     could attach the wrong person's card to a listing.
//
// Idempotent: a listing whose column already points at our bucket is skipped,
// so a re-run after a partial pass costs only the reads.
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-residence-documents.ts           # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-residence-documents.ts --commit  # writes
//   ... --limit 20      stop after N listings
//   ... --kind document|hostCard|ownerCard   only one kind

import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/prisma";
import { env } from "@/config/env";

const COMMIT = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const kindArg = process.argv.indexOf("--kind");
const ONLY_KIND = kindArg > -1 ? process.argv[kindArg + 1] : null;

const KINDS = [
  { key: "document", odooColumn: "x_residence_document", field: "documentUrl", label: "سند مالکیت" },
  { key: "hostCard", odooColumn: "x_host_national_card", field: "hostNationalCardUrl", label: "کارت ملی میزبان" },
  { key: "ownerCard", odooColumn: "x_owner_national_card", field: "ownerNationalCardUrl", label: "کارت ملی مالک" },
] as const;

type Kind = (typeof KINDS)[number];

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

function sniff(buf: Buffer): { ext: string; mime: string } | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: "png", mime: "image/png" };
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
    return { ext: "webp", mime: "image/webp" };
  if (buf.slice(0, 5).toString("ascii") === "%PDF-") return { ext: "pdf", mime: "application/pdf" };
  if (buf.slice(0, 2).toString("ascii") === "BM") return { ext: "bmp", mime: "image/bmp" };
  if (buf.slice(0, 6).toString("ascii").startsWith("GIF8")) return { ext: "gif", mime: "image/gif" };

  // HEIC — iPhone photos. 25 of these, and without this line they were the
  // whole of the "unknown type" pile and would have been silently left behind.
  //
  // Carried over as-is rather than converted: converting needs a native image
  // library (sharp/libheif) added to the deploy for 1% of the files. Chrome
  // will not render HEIC inline, so the panel offers these as a download
  // instead of a preview — the document is migrated and reachable, which is
  // what a migration owes it.
  const ftyp = buf.slice(4, 8).toString("ascii");
  if (ftyp === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1"))
      return { ext: "heic", mime: "image/heic" };
    if (brand.startsWith("hevc") || brand.startsWith("heim"))
      return { ext: "heif", mime: "image/heif" };
  }

  return null;
}

/**
 * Odoo hands these back as a Buffer of the *base64 text*, not of the bytes.
 * Decoding once gets the file; a caller that treats the column as binary
 * writes a JPEG-shaped text file and only finds out when nothing renders it.
 */
function decodeOdooBinary(value: unknown): Buffer | null {
  if (!value) return null;
  const raw = Buffer.isBuffer(value) ? value.toString("ascii") : String(value);
  const cleaned = raw.replace(/\s/g, "");
  if (!cleaned) return null;
  try {
    const buf = Buffer.from(cleaned, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

// Below this it is not a document — Odoo stores a few one-pixel leftovers.
const MIN_BYTES = 1024;

async function uploadDocument(buf: Buffer, ext: string, mime: string): Promise<string> {
  // Random, not derived from the listing id: a key anyone can compute is a key
  // anyone can fetch, and these are national ID cards.
  const key = `documents/${crypto.randomBytes(16).toString("hex")}.${ext}`;
  await s3!.send(
    new PutObjectCommand({
      Bucket: env.objectStorage.bucket!,
      Key: key,
      Body: buf,
      ContentType: mime,
    })
  );
  return `https://${env.objectStorage.bucket}.${env.objectStorage.endpoint}/${key}`;
}

const kB = (n: number) => `${Math.round(n / 1024)}KB`;

async function main() {
  console.log(`حالت: ${COMMIT ? "COMMIT (آپلود و نوشتن)" : "DRY RUN (بدون هیچ نوشتنی)"}`);
  if (COMMIT && !storageReady) {
    throw new Error("برای آپلود، متغیرهای LIARA_* لازم‌اند.");
  }

  const kinds = ONLY_KIND ? KINDS.filter((k) => k.key === ONLY_KIND) : [...KINDS];
  if (kinds.length === 0) throw new Error(`--kind نامعتبر: ${ONLY_KIND}`);

  // Only migrated listings can be matched, and the Odoo template id is in the
  // reference we assigned at migration time.
  const residences = await prisma.residence.findMany({
    where: { reference: { startsWith: "ODOO-" } },
    select: {
      id: true,
      reference: true,
      documentUrl: true,
      hostNationalCardUrl: true,
      ownerNationalCardUrl: true,
    },
  });

  const byOdooId = new Map<number, (typeof residences)[number]>();
  for (const r of residences) {
    const odooId = Number(r.reference!.slice("ODOO-".length));
    if (Number.isFinite(odooId)) byOdooId.set(odooId, r);
  }
  console.log(`اقامتگاه‌های مهاجرت‌شده: ${residences.length.toLocaleString("fa-IR")}\n`);

  const totals = {
    found: 0,
    alreadyDone: 0,
    noMatch: 0,
    tooSmall: 0,
    undecodable: 0,
    unknownType: 0,
    uploaded: 0,
    failed: 0,
    bytes: 0,
  };

  for (const kind of kinds as Kind[]) {
    console.log(`── ${kind.label} ──`);

    // id first so the set can be reported before pulling megabytes of base64.
    const ids = await odoo.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM product_template WHERE ${kind.odooColumn} IS NOT NULL ORDER BY id`
    );
    console.log(`  در Odoo: ${ids.length.toLocaleString("fa-IR")}`);

    const pending = ids
      .map((r) => Number(r.id))
      .filter((odooId) => {
        const residence = byOdooId.get(odooId);
        if (!residence) {
          totals.noMatch += 1;
          return false;
        }
        const current = residence[kind.field] as string | null;
        if (current) {
          totals.alreadyDone += 1;
          return false;
        }
        return true;
      })
      .slice(0, LIMIT);

    console.log(`  قابل انتقال: ${pending.length.toLocaleString("fa-IR")}`);

    const types = new Map<string, number>();
    let kindBytes = 0;
    let kindUploaded = 0;

    for (const odooId of pending) {
      const residence = byOdooId.get(odooId)!;

      // One row at a time: these are up to a few MB each and there are
      // thousands, so a single SELECT would pull the lot into memory.
      //
      // A dry run reads only the first 96 base64 characters and the column's
      // length. That is enough to sniff the type and report the size, and it
      // means counting what is there costs kilobytes instead of the ~2.4GB
      // that pulling every document would — which is a real difference when
      // the point of the dry run is to be run freely before committing.
      const rows = await odoo.$queryRawUnsafe<Record<string, unknown>[]>(
        COMMIT
          ? `SELECT ${kind.odooColumn} AS data, length(${kind.odooColumn}) AS len
             FROM product_template WHERE id = $1`
          : `SELECT substring(${kind.odooColumn} from 1 for 96) AS data,
                    length(${kind.odooColumn}) AS len
             FROM product_template WHERE id = $1`,
        odooId
      );
      const buf = decodeOdooBinary(rows[0]?.data);
      // base64 is 4 characters per 3 bytes; the real file size, not the
      // truncated sample's.
      const realBytes = Math.floor((Number(rows[0]?.len ?? 0) * 3) / 4);

      if (!buf) {
        totals.undecodable += 1;
        console.log(`  ✗ اقامتگاه ${residence.id}: داده قابل decode نبود`);
        continue;
      }
      if (realBytes < MIN_BYTES) {
        totals.tooSmall += 1;
        continue;
      }
      const type = sniff(buf);
      if (!type) {
        totals.unknownType += 1;
        console.log(`  ✗ اقامتگاه ${residence.id}: نوع فایل ناشناخته (${kB(realBytes)})`);
        continue;
      }

      types.set(type.ext, (types.get(type.ext) ?? 0) + 1);
      kindBytes += realBytes;
      totals.found += 1;

      if (!COMMIT) continue;

      try {
        const url = await uploadDocument(buf, type.ext, type.mime);
        await prisma.residence.update({
          where: { id: residence.id },
          data: { [kind.field]: url },
        });
        kindUploaded += 1;
        totals.uploaded += 1;
        if (kindUploaded % 50 === 0) {
          console.log(`  … ${kindUploaded.toLocaleString("fa-IR")} منتقل شد`);
        }
      } catch (error) {
        totals.failed += 1;
        console.log(
          `  ✗ اقامتگاه ${residence.id}: آپلود نشد — ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }

    totals.bytes += kindBytes;
    console.log(
      `  انواع فایل: ${[...types.entries()].map(([e, c]) => `${e}×${c}`).join(", ") || "—"}`
    );
    console.log(`  حجم کل: ${kB(kindBytes)}${COMMIT ? ` · منتقل‌شده: ${kindUploaded}` : ""}\n`);
  }

  console.log("── جمع‌بندی ──");
  console.log(`  قابل انتقال و سالم : ${totals.found.toLocaleString("fa-IR")}`);
  console.log(`  از قبل داشتند      : ${totals.alreadyDone.toLocaleString("fa-IR")}`);
  console.log(`  اقامتگاه پیدا نشد  : ${totals.noMatch.toLocaleString("fa-IR")}`);
  console.log(`  خیلی کوچک (نویز)   : ${totals.tooSmall.toLocaleString("fa-IR")}`);
  console.log(`  decode نشد         : ${totals.undecodable.toLocaleString("fa-IR")}`);
  console.log(`  نوع ناشناخته       : ${totals.unknownType.toLocaleString("fa-IR")}`);
  console.log(`  حجم کل             : ${kB(totals.bytes)}`);
  if (COMMIT) {
    console.log(`  آپلود شد           : ${totals.uploaded.toLocaleString("fa-IR")}`);
    console.log(`  ناموفق             : ${totals.failed.toLocaleString("fa-IR")}`);
  } else {
    console.log("\n  هیچ چیزی نوشته نشد. برای اجرای واقعی --commit را اضافه کنید.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await odoo.$disconnect();
    await prisma.$disconnect();
  });
