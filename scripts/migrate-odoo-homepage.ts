// One-off migration: the legacy Odoo home-page CMS (x_homepage_*, x_article)
// into home_settings / home_sections / home_banners / home_desc_sections /
// home_residence_types / home_sliders / home_trust_boxes / home_articles.
//
// The home page has been serving `emptyHomePageData` since the cutover — none
// of this was migrated with the rest.
//
// Odoo stored every image as a BINARY BLOB in the database, base64-encoded
// inside a bytea column. Unlike the residence images (which came from a
// pre-built image-map.json produced on the source server), there is no file to
// copy: each blob is decoded here and uploaded to object storage, and the
// resulting URL is what gets stored.
//
// Idempotent: rows key off odooId, and an image is only re-uploaded when the
// target row has no URL yet (or --reupload is passed).
//
// Usage:
//   npx tsx --env-file=.env scripts/migrate-odoo-homepage.ts            # dry run
//   npx tsx --env-file=.env scripts/migrate-odoo-homepage.ts --commit
//   npx tsx --env-file=.env scripts/migrate-odoo-homepage.ts --commit --reupload

import crypto from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";
import { env } from "@/config/env";

const COMMIT = process.argv.includes("--commit");
const REUPLOAD = process.argv.includes("--reupload");

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

// ---------------------------------------------------------------- storage

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

/** Odoo binary columns hold base64 text stored as bytea. */
function decodeOdooBlob(value: unknown): Buffer | null {
  if (!value) return null;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (buf.length === 0) return null;
  // The bytea contains the ASCII of a base64 string, not the raw image.
  const asText = buf.toString("ascii").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(asText)) return buf; // already raw
  const decoded = Buffer.from(asText, "base64");
  return decoded.length ? decoded : null;
}

/** Sniff the real type — Odoo kept no filename or mime alongside the blob. */
function sniffImage(buf: Buffer): { ext: string; mime: string } {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: "png", mime: "image/png" };
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
    return { ext: "webp", mime: "image/webp" };
  if (buf.slice(0, 3).toString("ascii") === "GIF") return { ext: "gif", mime: "image/gif" };
  if (buf.slice(0, 5).toString("ascii").includes("<svg")) return { ext: "svg", mime: "image/svg+xml" };
  return { ext: "bin", mime: "application/octet-stream" };
}

let uploaded = 0;
let uploadedBytes = 0;

async function uploadBlob(value: unknown, name: string): Promise<string | null> {
  const buf = decodeOdooBlob(value);
  if (!buf) return null;
  const { ext, mime } = sniffImage(buf);
  if (ext === "bin") {
    console.log(`    ! ${name}: unrecognised image format, skipped`);
    return null;
  }
  // Content-hashed so re-running never creates a second copy of the same image.
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const key = `homepage/${name}-${hash}.${ext}`;
  const url = `https://${env.objectStorage.bucket}.${env.objectStorage.endpoint}/${key}`;

  if (!COMMIT) {
    console.log(`    would upload ${key} (${(buf.length / 1024).toFixed(0)} KB)`);
    return url;
  }
  if (!s3) throw new Error("object storage is not configured (LIARA_* env vars)");

  await s3.send(
    new PutObjectCommand({
      Bucket: env.objectStorage.bucket!,
      Key: key,
      Body: buf,
      ContentType: mime,
      ACL: "public-read",
    })
  );
  uploaded++;
  uploadedBytes += buf.length;
  console.log(`    uploaded ${key} (${(buf.length / 1024).toFixed(0)} KB)`);
  return url;
}

const clean = (s: unknown): string | null => {
  const t = typeof s === "string" ? s.trim() : null;
  return t ? t : null;
};

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing + uploading)" : "DRY RUN (no writes, no uploads)"}`);
  if (COMMIT && !storageReady) {
    throw new Error("LIARA_* object storage env vars are required to upload the images.");
  }

  const [item] = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_items LIMIT 1`);
  if (!item) throw new Error("x_homepage_items is empty — nothing to migrate.");

  // ---------- settings ----------
  console.log("\n== settings ==");
  const existingSettings = await targetPrisma.homeSettings.findUnique({ where: { id: 1 } });
  const needHero = REUPLOAD || !existingSettings?.heroImageMobileUrl;

  const heroMobileUrl = needHero
    ? await uploadBlob(item.x_mobile_bg, "hero-mobile")
    : existingSettings?.heroImageMobileUrl ?? null;

  const settingsData = {
    heroTitle: clean(item.x_title),
    heroSubtitle: clean(item.x_subtitle),
    heroTitleMobile: clean(item.x_mobile_title),
    heroSubtitleMobile: clean(item.x_mobile_subtitle),
    heroImageMobileUrl: heroMobileUrl,
    pcTitleColor: clean(item.x_pc_title_color),
    pcSubtitleColor: clean(item.x_pc_subtitle_color),
    pcTitleSize: item.x_pc_title_size ?? null,
    pcSubtitleSize: item.x_pc_subtitle_size ?? null,
    mobileTitleColor: clean(item.x_mobile_title_color),
    mobileSubtitleColor: clean(item.x_mobile_subtitle_color),
    mobileTitleSize: item.x_mobile_title_size ?? null,
    mobileSubtitleSize: item.x_mobile_subtitle_size ?? null,
    searchBackground: clean(item.x_mobile_search_background),
    searchBorderColor: clean(item.x_mobile_search_border_color),
    // Odoo had no H1 field — the hero title is the closest thing it had to one,
    // and it reads as a page heading ("رزرو و اجاره آنلاین انواع اقامتگاه").
    h1: clean(item.x_title),
  };
  console.log(`  hero: "${settingsData.heroTitle}" / mobile "${settingsData.heroTitleMobile}"`);
  if (COMMIT) {
    await targetPrisma.homeSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...settingsData },
      update: settingsData,
    });
  }

  // ---------- section titles ----------
  // Odoo kept these as columns on the settings row; they are rows here.
  const SECTION_MAP: Record<string, [string, string]> = {
    suggest: ["x_suggest_title", "x_suggest_subtitle"],
    popular: ["x_popular_title", "x_popular_subtitle"],
    selected: ["x_selected_title", "x_selected_subtitle"],
    taste: ["x_taste_title", "x_taste_subtitle"],
    fast: ["x_fast_title", "x_fast_subtitle"],
    discount: ["x_discount_title", "x_discount_subtitle"],
    economical: ["x_economical_title", "x_economical_subtitle"],
    boomgardi: ["x_boomgardi_title", "x_boomgardi_subtitle"],
    hotel: ["x_hotel_title", "x_hotel_subtitle"],
    articles: ["x_articles_title", "x_articles_subtitle"],
    faq: ["x_faq_title", ""],
  };
  console.log("\n== section titles ==");
  let sections = 0;
  for (const [key, [tCol, sCol]] of Object.entries(SECTION_MAP)) {
    const title = clean(item[tCol]);
    const subtitle = sCol ? clean(item[sCol]) : null;
    if (!title && !subtitle) continue;
    console.log(`  ${key.padEnd(11)} ${title ?? ""}`);
    if (COMMIT) {
      await targetPrisma.homeSection.update({ where: { key }, data: { title, subtitle } });
    }
    sections++;
  }
  console.log(`  ${sections} section titles`);

  // ---------- banners ----------
  console.log("\n== banners ==");
  const banners = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_banners ORDER BY id`);
  for (const [i, b] of banners.entries()) {
    const existing = await targetPrisma.homeBanner.findUnique({ where: { odooId: b.id } });
    const need = REUPLOAD || !existing?.pcImageUrl;
    console.log(`  [${b.id}] ${b.x_name}`);
    const pcImageUrl = need ? await uploadBlob(b.x_pc_image, `banner-${b.id}-pc`) : existing?.pcImageUrl ?? null;
    const mobileImageUrl = need
      ? await uploadBlob(b.x_mobile_image, `banner-${b.id}-mobile`)
      : existing?.mobileImageUrl ?? null;
    const data = {
      name: clean(b.x_name) ?? `بنر ${b.id}`,
      link: clean(b.x_link),
      pcImageUrl,
      mobileImageUrl,
      // A banner with no image at all is inactive: Odoo's "بنر دوم" has
      // neither image nor link and would render as an empty slot.
      isActive: !!(pcImageUrl || mobileImageUrl),
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeBanner.upsert({
        where: { odooId: b.id },
        create: { odooId: b.id, ...data },
        update: data,
      });
    }
  }

  // ---------- description sections ----------
  console.log("\n== description sections ==");
  const descs = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_desc_sections ORDER BY id`);
  for (const [i, d] of descs.entries()) {
    const existing = await targetPrisma.homeDescSection.findUnique({ where: { odooId: d.id } });
    const need = REUPLOAD || !existing?.pcImageUrl;
    console.log(`  [${d.id}] ${d.x_title}`);
    const data = {
      title: clean(d.x_title),
      contentHtml: clean(d.x_content),
      pcImageUrl: need ? await uploadBlob(d.x_pc_image, `desc-${d.id}-pc`) : existing?.pcImageUrl ?? null,
      mobileImageUrl: need
        ? await uploadBlob(d.x_mobile_image, `desc-${d.id}-mobile`)
        : existing?.mobileImageUrl ?? null,
      alt: clean(d.x_title),
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeDescSection.upsert({
        where: { odooId: d.id },
        create: { odooId: d.id, ...data },
        update: data,
      });
    }
  }

  // ---------- residence types ----------
  console.log("\n== residence types ==");
  const types = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_res_types ORDER BY id`);
  // The desktop artwork for three of them lives on the settings row, not here.
  const PC_ART: Record<string, unknown> = {
    "ویلا": null,
    "سوئیت آپارتمان": item.x_suit_pc,
    "بوم گردی": item.x_boomgardi_pc,
    "هتل": item.x_hotel_pc,
  };
  for (const [i, t] of types.entries()) {
    const existing = await targetPrisma.homeResidenceType.findUnique({ where: { odooId: t.id } });
    const need = REUPLOAD || !existing?.imageUrl;
    console.log(`  [${t.id}] ${t.x_title}`);
    const imageUrl = need
      ? (await uploadBlob(t.x_image, `type-${t.id}`)) ??
        (await uploadBlob(PC_ART[String(t.x_name)], `type-${t.id}-pc`))
      : existing?.imageUrl ?? null;
    const data = {
      title: clean(t.x_title) ?? String(t.x_name),
      subtitle: clean(t.x_subtitle),
      imageUrl,
      alt: clean(t.x_title),
      link: clean(t.x_link),
      showInMobile: t.x_show_in_mobile ?? true,
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeResidenceType.upsert({
        where: { odooId: t.id },
        create: { odooId: t.id, ...data },
        update: data,
      });
    }
  }

  // ---------- seasonal sliders ----------
  console.log("\n== seasonal sliders ==");
  const sliders = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_sliders ORDER BY id`);
  for (const [i, s] of sliders.entries()) {
    const existing = await targetPrisma.homeSlider.findUnique({ where: { odooId: s.id } });
    const need = REUPLOAD || !existing?.imageUrl;
    console.log(`  [${s.id}] ${s.x_name}`);
    const data = {
      title: clean(s.x_name),
      imageUrl: need ? await uploadBlob(s.x_image, `slider-${s.id}`) : existing?.imageUrl ?? null,
      alt: clean(s.x_name),
      link: clean(s.x_link),
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeSlider.upsert({
        where: { odooId: s.id },
        create: { odooId: s.id, ...data },
        update: data,
      });
    }
  }

  // ---------- trust boxes ----------
  console.log("\n== trust boxes (چرا ما) ==");
  const boxes = await odoo.$queryRawUnsafe<any[]>(`SELECT * FROM x_homepage_trust_boxes ORDER BY id`);
  for (const [i, b] of boxes.entries()) {
    const existing = await targetPrisma.homeTrustBox.findUnique({ where: { odooId: b.id } });
    const need = REUPLOAD || !existing?.iconUrl;
    console.log(`  [${b.id}] ${b.x_title}`);
    const data = {
      title: clean(b.x_title) ?? String(b.x_name),
      subtitle: clean(b.x_subtitle),
      iconUrl: need ? await uploadBlob(b.x_image, `trust-${b.id}`) : existing?.iconUrl ?? null,
      alt: clean(b.x_title),
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeTrustBox.upsert({
        where: { odooId: b.id },
        create: { odooId: b.id, ...data },
        update: data,
      });
    }
  }

  // ---------- articles ----------
  console.log("\n== articles ==");
  const articles = await odoo.$queryRawUnsafe<any[]>(
    `SELECT * FROM x_article ORDER BY COALESCE(x_slider_sequence, 999), id`
  );
  for (const [i, a] of articles.entries()) {
    const existing = await targetPrisma.homeArticle.findUnique({ where: { odooId: a.id } });
    const need = REUPLOAD || !existing?.imageUrl;
    const title = clean(a.x_title) ?? String(a.x_name ?? "");
    // "تست نویسنده" is leftover test content, and a linkless article is a dead
    // card — both are imported but switched off rather than silently dropped.
    const isJunk = /^تست/.test(title) || !clean(a.x_link);
    console.log(`  [${a.id}] ${title}${isJunk ? "  (inactive: test/no link)" : ""}`);
    const data = {
      title,
      link: clean(a.x_link),
      imageUrl: need ? await uploadBlob(a.x_image, `article-${a.id}`) : existing?.imageUrl ?? null,
      alt: title,
      authorName: clean(a.x_author_name),
      authorImageUrl: need
        ? await uploadBlob(a.x_author_image, `article-${a.id}-author`)
        : existing?.authorImageUrl ?? null,
      isActive: !isJunk,
      sortOrder: i + 1,
    };
    if (COMMIT) {
      await targetPrisma.homeArticle.upsert({
        where: { odooId: a.id },
        create: { odooId: a.id, ...data },
        update: data,
      });
    }
  }

  console.log(
    `\n${COMMIT ? "Uploaded" : "Would upload"} ${uploaded} images` +
      (COMMIT ? ` (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB)` : "")
  );
  if (!COMMIT) console.log("\nDry run complete — re-run with --commit to write.");
  else console.log("\nDone.");
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
