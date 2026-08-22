// One-off migration: product_template + x_room (legacy Odoo, restored into
// the sibling `odoo_legacy` database) -> residences/rooms/residence_images.
//
// Usage:
//   npx tsx scripts/migrate-odoo-residences.ts               # dry run
//   npx tsx scripts/migrate-odoo-residences.ts --commit        # writes
//
// Prerequisite: scripts/migrate-odoo-users.ts must have already run — hosts
// are resolved by phone against the *already-migrated* `users` table, not
// created here.
//
// Scope decisions (confirmed with the project owner):
//   - Only website_published=true, active=true residences are migrated.
//   - Rooms (x_room) are migrated in this same pass.
//   - Images ARE migrated — extracted from the Odoo filestore on the source
//     server (not this Postgres dump) by scripts/upload-images.js (see
//     backend/scripts/README-odoo-migration.md), uploaded to the same Liara
//     Object Storage bucket the app already uses, and consumed here via the
//     `--image-map` JSON file it produces.
//   - Amenities, rules, and calendar days are NOT migrated — the target
//     `amenities`/`rules` catalogs are essentially unseeded (2 and 1 rows),
//     so there is nothing meaningful to link Odoo's x_rooms_features against
//     yet. Same reasoning as cityId in the user migration.

import fs from "fs";
import { PrismaClient } from "@/generated/prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
// DATABASE_URL sets connection_limit=20 (see migrate-odoo-users.ts) — kept a
// bit lower than that script's concurrency since each item here does several
// sequential writes (residence + rooms + images), not just one.
const CONCURRENCY = 12;
const imageMapArgIdx = process.argv.indexOf("--image-map");
const IMAGE_MAP_PATH =
  imageMapArgIdx !== -1 ? process.argv[imageMapArgIdx + 1] : "scripts/image-map.json";

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface ImageMap {
  mainImageByTemplate: Record<string, string>;
  galleryByTemplate: Record<string, string[]>;
  roomImageByRoom: Record<string, string>;
}

function loadImageMap(): ImageMap {
  if (!fs.existsSync(IMAGE_MAP_PATH)) {
    console.warn(`No image map found at ${IMAGE_MAP_PATH} — residences will be migrated without photos.`);
    return { mainImageByTemplate: {}, galleryByTemplate: {}, roomImageByRoom: {} };
  }
  return JSON.parse(fs.readFileSync(IMAGE_MAP_PATH, "utf8"));
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

// Odoo's website editor content — good enough for a plain-text fallback;
// this isn't trying to be a full HTML sanitizer, just to avoid dumping raw
// tags into a field the new frontend renders as plain text.
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
  return text || null;
}

// Odoo stored these as free-text (varchar), not booleans — best-effort read.
function textToBool(v: string | null): boolean | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return !/^(ندارد|خیر|no|false|0)$/i.test(t);
}
function textToBedRoomType(v: string | null): "NONE" | "SHARED" | "DEDICATED" | null {
  if (!v) return null;
  if (/اختصاصی|مستقل/.test(v)) return "DEDICATED";
  if (/مشترک/.test(v)) return "SHARED";
  if (/ندارد/.test(v)) return "NONE";
  return null;
}

interface OdooResidence {
  id: number;
  name: string | null;
  description: string | null;
  address: string | null;
  neighborhood: string | null;
  floor: string | null;
  latitude: number | null;
  longitude: number | null;
  foundation_area: number | null;
  total_area: number | null;
  capacity: number | null;
  max_capacity: number | null;
  checkin_time: string | null;
  checkout_time: string | null;
  min_reserve_days: number | null;
  extra_rules: string | null;
  cancelation_rule: string | null;
  cancel_commission: number | null;
  reserve_commission: number | null;
  host_share_past_nights: number | null;
  host_share_future_nights: number | null;
  full_return_time: number | null;
  before_start_time: number | null;
  week_price: number | null;
  weekend_price: number | null;
  peak_price: number | null;
  extra_guests_price: number | null;
  weekly_discount: number | null;
  monthly_discount: number | null;
  is_fast: boolean | null;
  boomgardi_type: string | null;
  create_date: Date | null;
  write_date: Date | null;
  host_phone: string | null;
  host_mobile: string | null;
}

interface OdooRoom {
  id: number;
  template_id: number;
  name: string | null;
  description: string | null;
  capacity: number | null;
  extra_capacity: number | null;
  single_bed: number | null;
  double_bed: number | null;
  traditional_bed: number | null;
  price: number | null;
  weekend_price: number | null;
  peak_price: number | null;
  peak_extra_price: number | null;
  cooling_system: string | null;
  heating_system: string | null;
  free_breakfast: boolean | null;
  separate_bathroom: boolean | null;
  wc: string | null;
  fridge: string | null;
}

async function fetchResidences(): Promise<OdooResidence[]> {
  return odoo.$queryRawUnsafe<OdooResidence[]>(`
    SELECT
      pt.id,
      pt.name,
      NULLIF(pt.website_description, '') AS description,
      NULLIF(trim(pt.x_address), '') AS address,
      NULLIF(trim(pt.x_neigborhood), '') AS neighborhood,
      NULLIF(trim(pt.x_floor), '') AS floor,
      NULLIF(trim(pt.x_lattitude), '')::float AS latitude,
      NULLIF(trim(pt.x_longitude), '')::float AS longitude,
      pt.x_foundation_area AS foundation_area,
      pt.x_total_area AS total_area,
      pt.x_capacity AS capacity,
      pt.x_max_capacity AS max_capacity,
      NULLIF(trim(pt.x_checkin_time), '') AS checkin_time,
      NULLIF(trim(pt.x_checkout_time), '') AS checkout_time,
      pt.x_min_reserve_days AS min_reserve_days,
      NULLIF(pt.x_extra_rules, '') AS extra_rules,
      NULLIF(trim(pt.x_cancelation_rule), '') AS cancelation_rule,
      pt.x_cancel_commission AS cancel_commission,
      pt.x_reserve_commission AS reserve_commission,
      pt.x_host_share_past_nights AS host_share_past_nights,
      pt.x_host_share_future_nights AS host_share_future_nights,
      pt.x_full_return_time AS full_return_time,
      pt.x_before_start_time AS before_start_time,
      pt.x_week_price AS week_price,
      pt.x_weekend_price AS weekend_price,
      pt.x_peak_price AS peak_price,
      pt.x_extra_guests_price AS extra_guests_price,
      pt.x_weekly_discount AS weekly_discount,
      pt.x_monthly_discount AS monthly_discount,
      COALESCE(pt.x_is_fast_now, false) AS is_fast,
      NULLIF(trim(pt.x_boomgardi_type), '') AS boomgardi_type,
      pt.create_date,
      pt.write_date,
      rp.phone AS host_phone,
      rp.mobile AS host_mobile
    FROM product_template pt
    LEFT JOIN res_partner rp ON rp.id = pt.x_host_id
    WHERE pt.website_published = true AND (pt.active IS NULL OR pt.active = true)
  `);
}

async function fetchRooms(): Promise<OdooRoom[]> {
  return odoo.$queryRawUnsafe<OdooRoom[]>(`
    SELECT
      r.id,
      r.x_template_id AS template_id,
      NULLIF(trim(r.x_name), '') AS name,
      NULLIF(trim(r.x_description), '') AS description,
      r.x_capacity AS capacity,
      r.x_extra_capacity AS extra_capacity,
      r.x_single_bed AS single_bed,
      r.x_double_bed AS double_bed,
      r.x_traditional_bed AS traditional_bed,
      r.x_price AS price,
      r.x_weekend_price AS weekend_price,
      r.x_peak_price AS peak_price,
      r.x_peak_extra_price AS peak_extra_price,
      NULLIF(trim(r.x_cooling_system), '') AS cooling_system,
      NULLIF(trim(r.x_heating_system), '') AS heating_system,
      r.x_free_breakfast AS free_breakfast,
      r.x_separate_bathroom AS separate_bathroom,
      NULLIF(trim(r.x_wc), '') AS wc,
      NULLIF(trim(r.x_fridge), '') AS fridge
    FROM x_room r
    JOIN product_template pt ON pt.id = r.x_template_id
    WHERE pt.website_published = true AND (pt.active IS NULL OR pt.active = true)
  `);
}

async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to target DB)" : "DRY RUN (no writes)"}`);
  const imageMap = loadImageMap();

  console.log("Fetching residences + rooms from odoo_legacy...");
  const [residences, rooms] = await Promise.all([fetchResidences(), fetchRooms()]);
  console.log(`Fetched ${residences.length} published residences, ${rooms.length} rooms.`);

  const roomsByTemplate = new Map<number, OdooRoom[]>();
  for (const r of rooms) {
    (roomsByTemplate.get(r.template_id) ?? roomsByTemplate.set(r.template_id, []).get(r.template_id)!).push(r);
  }

  // Resolve + cache host phone -> target user id once per unique phone.
  const hostIdByPhone = new Map<string, number | null>();
  async function resolveHostId(phone: string): Promise<number | null> {
    if (hostIdByPhone.has(phone)) return hostIdByPhone.get(phone)!;
    const user = await targetPrisma.user.findUnique({ where: { phone }, select: { id: true } });
    hostIdByPhone.set(phone, user?.id ?? null);
    return user?.id ?? null;
  }

  let skippedNoHost = 0;
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;
  let roomsCreated = 0;
  let imagesCreated = 0;

  const samples: string[] = [];

  await runConcurrent(residences, CONCURRENCY, async (res) => {
    const phone = normalizePhone(res.host_mobile) ?? normalizePhone(res.host_phone);
    const hostId = phone ? await resolveHostId(phone) : null;
    if (!hostId) {
      skippedNoHost++;
      return;
    }

    const reference = `ODOO-${res.id}`;
    const type = res.boomgardi_type ? "BOOMGARDI" : "SUIT";
    const mainImage = imageMap.mainImageByTemplate[res.id];
    const gallery = imageMap.galleryByTemplate[res.id] ?? [];
    const allImageUrls = [...(mainImage ? [mainImage] : []), ...gallery];

    if (samples.length < 5) {
      samples.push(
        JSON.stringify({ id: res.id, name: res.name, type, hostId, images: allImageUrls.length })
      );
    }

    if (!COMMIT) return;

    try {
      const existing = await targetPrisma.residence.findUnique({ where: { reference }, select: { id: true } });
      if (existing) {
        alreadyExists++;
        return;
      }

      const residence = await targetPrisma.residence.create({
        data: {
          reference,
          hostId,
          type,
          state: "PUBLISHED",
          published: true,
          name: res.name ?? "بدون نام",
          description: stripHtml(res.description),
          address: res.address,
          neighborhood: res.neighborhood,
          floor: res.floor,
          latitude: res.latitude,
          longitude: res.longitude,
          foundationArea: res.foundation_area,
          totalArea: res.total_area,
          capacity: res.capacity,
          maxCapacity: res.max_capacity,
          checkinFrom: res.checkin_time,
          checkout: res.checkout_time,
          minReservableDays: res.min_reserve_days,
          rulesDesc: res.extra_rules,
          cancellationPolicyDesc: res.cancelation_rule,
          cancelCommission: res.cancel_commission,
          reserveCommission: res.reserve_commission,
          hostSharePastNights: res.host_share_past_nights,
          hostShareFutureNights: res.host_share_future_nights,
          fullReturnTime: res.full_return_time,
          beforeStartTime: res.before_start_time,
          weekPrice: res.week_price,
          weekendPrice: res.weekend_price,
          peakPrice: res.peak_price,
          extraGuestsPrice: res.extra_guests_price,
          weeklyDiscount: res.weekly_discount,
          monthlyDiscount: res.monthly_discount,
          isFast: !!res.is_fast,
          createdAt: res.create_date ?? new Date(),
          updatedAt: res.write_date ?? new Date(),
        },
      });
      created++;

      if (allImageUrls.length) {
        await targetPrisma.residenceImage.createMany({
          data: allImageUrls.map((url, i) => ({
            residenceId: residence.id,
            url,
            sortOrder: i,
            isMain: i === 0,
          })),
        });
        imagesCreated += allImageUrls.length;
      }

      const templateRooms = roomsByTemplate.get(res.id) ?? [];
      for (const r of templateRooms) {
        await targetPrisma.room.create({
          data: {
            residenceId: residence.id,
            name: r.name ?? "اتاق",
            description: r.description,
            image: imageMap.roomImageByRoom[r.id] ?? null,
            capacity: r.capacity,
            maxCapacity: r.capacity != null && r.extra_capacity != null ? r.capacity + r.extra_capacity : r.capacity,
            singleBed: r.single_bed ?? 0,
            doubleBed: r.double_bed ?? 0,
            traditionalBed: r.traditional_bed ?? 0,
            weekPrice: r.price,
            weekendPrice: r.weekend_price,
            peakPrice: r.peak_price,
            extraPeakPrice: r.peak_extra_price,
            coolingSystem: textToBool(r.cooling_system),
            heatingSystem: textToBool(r.heating_system),
            freeBreakfast: r.free_breakfast ?? undefined,
            separateBathroom: r.separate_bathroom ?? undefined,
            wc: textToBedRoomType(r.wc) ?? undefined,
            refrigerator: textToBedRoomType(r.fridge) ?? undefined,
          },
        });
        roomsCreated++;
      }
    } catch (err) {
      failed++;
      console.error(`Failed odoo template id=${res.id}:`, (err as Error).message);
    }
  });

  console.log(`\nPlanned/processed ${residences.length} residences.`);
  console.log(`Skipped ${skippedNoHost} (host has no migrated user — no valid phone).`);
  console.log("\nSample of first 5:");
  samples.forEach((s) => console.log(s));

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  console.log(
    `\nDone. Created ${created} residences (${roomsCreated} rooms, ${imagesCreated} images), already existed ${alreadyExists}, failed ${failed}.`
  );
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
