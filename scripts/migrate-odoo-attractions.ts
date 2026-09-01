/**
 * جاذبه‌های گردشگری — recovers the catalogue Odoo had and the first migration
 * dropped.
 *
 * `x_residence_place_distance.x_place` is a foreign key to `x_attractions`.
 * The original migration read through it, copied the label onto each distance
 * row, and never brought the catalogue itself — which is why 14,866 distance
 * rows exist as 4,040 spellings of a few hundred places, and why nothing could
 * answer "what is near this listing".
 *
 * What comes across:
 *   • name           ← x_name
 *   • latitude/lng   ← x_position, a "[lat,lng]" string, present on 720 rows
 *   • locationId     ← x_city_id, but NOT the way it first looks. That column
 *                      is a foreign key to `res_better_zip` — a postal-code
 *                      table — and NOT to `product_public_category`, which is
 *                      what Location.odooId holds. Matching the two id spaces
 *                      "worked" for 181 of 365 cities and every one of them
 *                      was wrong: Tehran's museums came out labelled رامسر.
 *                      So the join goes through res_better_zip's city NAME,
 *                      disambiguated by its province. 320 of 365 match; the
 *                      other 45 are towns our Location tree does not have and
 *                      import with no city rather than a wrong one.
 *
 * It also relinks existing distance rows to the catalogue where the label
 * matches an attraction name **exactly, within the same city**. Exact-only on
 * purpose: fuzzy-matching 4,040 free-text spellings would silently attach the
 * wrong place, and a wrong attachment is worse than none — it would put a
 * computed distance under a name it does not belong to.
 *
 * Usage:
 *   npx tsx scripts/migrate-odoo-attractions.ts            # dry run
 *   npx tsx scripts/migrate-odoo-attractions.ts --commit   # writes
 */
import { PrismaClient } from "@prisma/client";

const commit = process.argv.includes("--commit");

const prisma = new PrismaClient();

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();
const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

const fa = (n: number) => n.toLocaleString("fa-IR");

interface OdooAttraction {
  id: number;
  x_name: string | null;
  x_position: string | null;
  x_city_id: number | null;
}

/**
 * Odoo stores the position as the string "[35.123,51.456]".
 *
 * Anything that does not parse to two finite numbers in range is imported
 * without coordinates rather than with a guess — an attraction with a wrong
 * position would place itself near listings it is nowhere near.
 */
function parsePosition(raw: string | null): { lat: number; lng: number } | null {
  if (!raw) return null;
  // Brackets are optional on both ends. 105 rows are stored as
  // "32.4568763,60.4051066]" — a missing opening bracket, and otherwise
  // perfectly good coordinates for real places (روستای ماخونیک, برج طغرل ری,
  // تنگه واشی…). Requiring both brackets discarded every one of them.
  const m = raw.match(/^\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // Iran's bounding box, generously. A position outside it is data damage, not
  // a foreign attraction — this catalogue is entirely domestic.
  if (lat < 24 || lat > 40.5 || lng < 43 || lng > 64) return null;
  return { lat, lng };
}

async function main() {
  console.log(commit ? "── اجرای واقعی ──\n" : "── اجرای آزمایشی (بدون نوشتن) ──\n");

  const rows = await odoo.$queryRawUnsafe<OdooAttraction[]>(
    `SELECT id, x_name, x_position, x_city_id FROM x_attractions ORDER BY id`
  );
  console.log(`جاذبه در اودو: ${fa(rows.length)}`);

  const cityIds = [...new Set(rows.map((r) => r.x_city_id).filter((v): v is number => v != null))];

  // x_city_id -> res_better_zip, whose useful columns are the city name and a
  // "city, province, country" display name. There is no shared id with our
  // Location table, so the name is the only join available.
  const zips = await odoo.$queryRawUnsafe<{ id: number; city: string | null; display_name: string | null }[]>(
    `SELECT id, city, display_name FROM res_better_zip WHERE id = ANY($1::int[])`,
    cityIds
  );

  const ourCities = await prisma.location.findMany({
    where: { type: "CITY" },
    select: { id: true, name: true, parent: { select: { name: true } } },
  });

  const byName = new Map<string, { id: number; province: string | null }[]>();
  for (const c of ourCities) {
    const key = c.name.trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push({ id: c.id, province: c.parent?.name?.trim() ?? null });
  }

  const locationByOdoo = new Map<number, number>();
  let ambiguousCities = 0;
  let unmatchedCities = 0;

  for (const z of zips) {
    const name = z.city?.trim();
    if (!name) continue;
    const candidates = byName.get(name);
    if (!candidates?.length) {
      unmatchedCities += 1;
      continue;
    }
    if (candidates.length === 1) {
      locationByOdoo.set(z.id, candidates[0].id);
      continue;
    }
    // Two cities share a name. display_name is "شهر, استان, ایران", so the
    // province settles it; if it does not, the row gets no city rather than a
    // coin flip between two real places.
    const province = z.display_name?.split(",")[1]?.trim();
    const exact = candidates.filter((c) => c.province && province && c.province === province);
    if (exact.length === 1) locationByOdoo.set(z.id, exact[0].id);
    else ambiguousCities += 1;
  }

  console.log(
    `شهرها: ${fa(cityIds.length)} در اودو، ${fa(locationByOdoo.size)} تطبیق خورد، ` +
      `${fa(unmatchedCities)} در Location نبود، ${fa(ambiguousCities)} مبهم`
  );

  /** What a dry run would insert, so the relink pass has something to match. */
  const planned: { id: number; name: string; locationId: number | null }[] = [];

  let created = 0;
  let updated = 0;
  let skippedNoName = 0;
  let withCoords = 0;
  let badPosition = 0;
  let noCity = 0;

  for (const row of rows) {
    const name = row.x_name?.trim();
    if (!name) {
      skippedNoName += 1;
      continue;
    }

    const pos = parsePosition(row.x_position);
    if (row.x_position && !pos) badPosition += 1;
    if (pos) withCoords += 1;

    const locationId = row.x_city_id ? locationByOdoo.get(row.x_city_id) ?? null : null;
    if (row.x_city_id && !locationId) noCity += 1;

    const data = {
      name,
      latitude: pos?.lat ?? null,
      longitude: pos?.lng ?? null,
      locationId,
    };

    if (commit) {
      const existing = await prisma.attraction.findUnique({
        where: { odooId: row.id },
        select: { id: true },
      });
      if (existing) {
        await prisma.attraction.update({ where: { odooId: row.id }, data });
        updated += 1;
      } else {
        await prisma.attraction.create({ data: { odooId: row.id, ...data } });
        created += 1;
      }
    } else {
      planned.push({ id: row.id, name, locationId });
      created += 1;
    }

    if ((created + updated) % 2000 === 0) console.log(`  … ${fa(created + updated)} پردازش شد`);
  }

  console.log(`\n── کاتالوگ ──`);
  console.log(`  ساخته شد: ${fa(created)}`);
  if (commit) console.log(`  به‌روزرسانی: ${fa(updated)}`);
  console.log(`  با مختصات: ${fa(withCoords)}`);
  console.log(`  مختصات نامعتبر (بدون مختصات وارد شد): ${fa(badPosition)}`);
  console.log(`  بدون نام (رد شد): ${fa(skippedNoName)}`);
  console.log(`  شهرش در Location نبود: ${fa(noCity)}`);

  // ---- relink existing distance rows, exact name + same city only ----
  console.log(`\n── اتصال ردیف‌های فاصله‌ی موجود ──`);

  const distances = await prisma.residenceDistance.findMany({
    where: { attractionId: null },
    select: {
      id: true,
      placeName: true,
      residence: { select: { locationId: true } },
    },
  });
  console.log(`  ردیف بدون اتصال: ${fa(distances.length)}`);

  // On a dry run the catalogue is not in the database yet, so the map is built
  // from what this run *would* insert. Reading the empty table instead reports
  // "0 linked" every time, which makes the dry run useless for the decision it
  // exists to inform.
  const catalogue = commit
    ? await prisma.attraction.findMany({ select: { id: true, name: true, locationId: true } })
    : planned;

  // (city, exact name) -> attraction. A name alone is not enough: "موزه بزرگ"
  // exists in several cities and would attach the wrong one.
  const byCityName = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const a of catalogue) {
    if (a.locationId == null) continue;
    const key = `${a.locationId}::${a.name.trim()}`;
    if (byCityName.has(key)) ambiguous.add(key);
    else byCityName.set(key, a.id);
  }

  let linked = 0;
  let unmatched = 0;
  for (const d of distances) {
    const locationId = d.residence?.locationId;
    if (locationId == null) {
      unmatched += 1;
      continue;
    }
    const key = `${locationId}::${d.placeName.trim()}`;
    const attractionId = byCityName.get(key);
    if (!attractionId || ambiguous.has(key)) {
      unmatched += 1;
      continue;
    }
    if (commit) {
      await prisma.residenceDistance.update({ where: { id: d.id }, data: { attractionId } });
    }
    linked += 1;
    if (linked % 1000 === 0) console.log(`  … ${fa(linked)} متصل شد`);
  }

  console.log(`  متصل شد: ${fa(linked)}`);
  console.log(`  بدون تطبیق دقیق (متن آزاد می‌ماند): ${fa(unmatched)}`);

  if (!commit) {
    console.log(`\nهیچ‌چیز نوشته نشد. برای اجرای واقعی: --commit`);
  }

  await prisma.$disconnect();
  await odoo.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  await odoo.$disconnect().catch(() => {});
  process.exit(1);
});
