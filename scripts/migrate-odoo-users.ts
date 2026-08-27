// One-off migration: res_partner (legacy Odoo, restored into the sibling
// `odoo_legacy` database on the same Postgres server) -> users/bank_accounts
// in this app's own schema.
//
// Usage:
//   npx tsx scripts/migrate-odoo-users.ts            # dry run, no writes
//   npx tsx scripts/migrate-odoo-users.ts --commit    # actually writes
//
// Scope decisions (confirmed with the project owner before writing this):
//   - Every res_partner row with a usable phone/mobile is migrated (not just
//     res_users-linked ones or hosts only).
//   - passwordHash is left null — Odoo's password hash (pbkdf2 via passlib)
//     is not bcrypt-compatible, so migrated accounts log in via OTP and can
//     set a new password afterwards.
//   - Avatar / national-card / birth-certificate images (stored as bytea in
//     Odoo) are NOT migrated in this pass — 300k+ blobs would need
//     extract-and-reupload-to-object-storage, deliberately deferred.
//   - cityId is left null for now — the target `cities` catalog only has 2
//     seed rows, so text matching would fail for ~everyone anyway.

import { PrismaClient } from "@prisma/client";
import { prisma as targetPrisma } from "@/lib/prisma";

const COMMIT = process.argv.includes("--commit");
// DATABASE_URL now sets connection_limit=20 — keep this a bit under that so
// the pool never queues (the earlier run at 25 vs the old default pool of 5
// spent most of its time retrying on timeouts instead of doing real work).
const CONCURRENCY = 15;

const odooUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set");
  return base.replace(/\/[^/?]+(\?|$)/, "/odoo_legacy$1");
})();

const odoo = new PrismaClient({ datasources: { db: { url: odooUrl } } });

interface OdooRow {
  id: number;
  name: string | null;
  email: string | null;
  national_code: string | null;
  address: string | null;
  zip: string | null;
  fax: string | null;
  job: string | null;
  education: string | null;
  birth_day: number | null;
  birth_month: number | null;
  birth_year: number | null;
  emergency_phone: string | null;
  is_host: boolean | null;
  create_date: Date | null;
  write_date: Date | null;
  phone: string | null;
  mobile: string | null;
  has_login: boolean;
  card_number: string | null;
  shaba_number: string | null;
  card_owner_raw: string | null;
  card_holder_raw: string | null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

const JUNK_NAME_VALUES = new Set(["undefined", "وارد نشده", "-", "نامشخص"]);
function cleanName(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t || JUNK_NAME_VALUES.has(t)) return null;
  return t;
}

interface Planned {
  phone: string;
  contactPhone: string | null;
  odooId: number;
  data: {
    name: string | null;
    email: string | null;
    nationalCode: string | null;
    address: string | null;
    zip: string | null;
    fax: string | null;
    job: string | null;
    education: string | null;
    birthDay: number | null;
    birthMonth: number | null;
    birthYear: number | null;
    emergencyPhone: string | null;
    isHost: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  bank: { cardNumber: string | null; cardOwnerName: string | null; shabaNumber: string | null } | null;
}

async function fetchOdooRows(): Promise<OdooRow[]> {
  return odoo.$queryRawUnsafe<OdooRow[]>(`
    SELECT
      rp.id,
      rp.name,
      rp.email,
      NULLIF(trim(rp.x_code_melli), '') AS national_code,
      NULLIF(trim(rp.street), '') AS address,
      NULLIF(trim(rp.zip), '') AS zip,
      NULLIF(trim(rp.fax), '') AS fax,
      NULLIF(trim(rp.x_job), '') AS job,
      NULLIF(trim(rp.x_education), '') AS education,
      rp.x_birthday_day AS birth_day,
      rp.x_birthday_month AS birth_month,
      rp.x_birthday_year AS birth_year,
      NULLIF(trim(rp.x_emergency_phone), '') AS emergency_phone,
      COALESCE(rp.x_is_host, false) AS is_host,
      rp.create_date,
      rp.write_date,
      rp.phone,
      rp.mobile,
      (ru.id IS NOT NULL) AS has_login,
      NULLIF(regexp_replace(rp.x_credit_card, '\\D', '', 'g'), '') AS card_number,
      NULLIF(regexp_replace(rp.x_shaba, '\\D', '', 'g'), '') AS shaba_number,
      NULLIF(trim(rp.x_credit_card_owner), '') AS card_owner_raw,
      NULLIF(trim(rp.x_credit_card_holder), '') AS card_holder_raw
    FROM res_partner rp
    LEFT JOIN res_users ru ON ru.partner_id = rp.id
    WHERE rp.phone IS NOT NULL OR rp.mobile IS NOT NULL
  `);
}

function buildPlan(rows: OdooRow[]) {
  const byPhone = new Map<string, { row: OdooRow; contactPhone: string | null }>();
  let skippedNoValidPhone = 0;

  for (const row of rows) {
    const mobileNorm = normalizePhone(row.mobile);
    const phoneNorm = normalizePhone(row.phone);
    const primary = mobileNorm ?? phoneNorm;
    if (!primary) {
      skippedNoValidPhone++;
      continue;
    }
    const other = primary === mobileNorm ? phoneNorm : mobileNorm;
    const contactPhone = other && other !== primary ? other : null;

    const existing = byPhone.get(primary);
    if (!existing) {
      byPhone.set(primary, { row, contactPhone });
      continue;
    }
    // dedup: prefer a res_users-linked row, then the more recently written one
    const existingScore = [existing.row.has_login, existing.row.write_date?.getTime() ?? 0] as const;
    const candidateScore = [row.has_login, row.write_date?.getTime() ?? 0] as const;
    const candidateWins =
      candidateScore[0] !== existingScore[0] ? candidateScore[0] : candidateScore[1] > existingScore[1];
    if (candidateWins) byPhone.set(primary, { row, contactPhone });
  }

  const planned: Planned[] = [];
  for (const [phone, { row, contactPhone }] of byPhone) {
    const cardNumber = row.card_number;
    const shabaNumber = row.shaba_number;
    const cardOwnerName = cleanName(row.card_owner_raw) ?? cleanName(row.card_holder_raw);
    const bank = cardNumber || shabaNumber ? { cardNumber, cardOwnerName, shabaNumber } : null;

    planned.push({
      phone,
      contactPhone,
      odooId: row.id,
      data: {
        name: row.name,
        email: row.email,
        nationalCode: row.national_code,
        address: row.address,
        zip: row.zip,
        fax: row.fax,
        job: row.job,
        education: row.education,
        birthDay: row.birth_day,
        birthMonth: row.birth_month,
        birthYear: row.birth_year,
        emergencyPhone: row.emergency_phone,
        isHost: !!row.is_host,
        createdAt: row.create_date ?? new Date(),
        updatedAt: row.write_date ?? new Date(),
      },
      bank,
    });
  }

  return { planned, skippedNoValidPhone, duplicateGroups: rows.length - byPhone.size - skippedNoValidPhone };
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
  console.log("Fetching res_partner rows from odoo_legacy...");
  const rows = await fetchOdooRows();
  console.log(`Fetched ${rows.length} candidate rows.`);

  const { planned, skippedNoValidPhone, duplicateGroups } = buildPlan(rows);
  console.log(`Planned ${planned.length} users to migrate.`);
  console.log(`Skipped ${skippedNoValidPhone} rows (no valid 09xxxxxxxxx phone).`);
  console.log(`Collapsed ${duplicateGroups} duplicate-phone rows into their winning record.`);
  console.log(`Of those, ${planned.filter((p) => p.bank).length} have bank-account info to migrate.`);
  console.log(`Of those, ${planned.filter((p) => p.data.isHost).length} are flagged as hosts.`);

  console.log("\nSample of first 5 planned rows:");
  for (const p of planned.slice(0, 5)) {
    console.log(
      JSON.stringify({ phone: p.phone, name: p.data.name, isHost: p.data.isHost, bank: !!p.bank })
    );
  }

  if (!COMMIT) {
    console.log("\nDry run complete — no rows written. Re-run with --commit to write.");
    return;
  }

  let created = 0;
  let alreadyExists = 0;
  let failed = 0;

  await runConcurrent(planned, CONCURRENCY, async (p) => {
    try {
      const existing = await targetPrisma.user.findUnique({ where: { phone: p.phone }, select: { id: true } });
      if (existing) {
        alreadyExists++;
        return;
      }
      const user = await targetPrisma.user.create({
        data: { phone: p.phone, contactPhone: p.contactPhone, ...p.data },
      });
      if (p.bank) {
        await targetPrisma.bankAccount.create({
          data: { userId: user.id, ...p.bank },
        });
      }
      created++;
    } catch (err) {
      failed++;
      console.error(`Failed odoo id=${p.odooId} phone=${p.phone}:`, (err as Error).message);
    }
  });

  console.log(`\nDone. Created ${created}, already existed ${alreadyExists}, failed ${failed}.`);
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
