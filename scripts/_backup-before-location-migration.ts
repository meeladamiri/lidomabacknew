// Temporary: snapshot the tables the location-tree migration rewrites, so the
// pre-migration state can be restored if the parity check fails.
import { prisma } from "@/lib/prisma";

const RESTORE = process.argv.includes("--restore-check");

async function main() {
  if (RESTORE) {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string; n: number }[]>(`
      SELECT table_name, (xpath('/row/c/text()',
        query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text::int AS n
      FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE '_backup_%'
      ORDER BY table_name`);
    console.log("Existing backups:");
    rows.forEach((r) => console.log(`  ${r.table_name}: ${r.n} rows`));
    return;
  }

  for (const t of ["provinces", "cities", "residences", "users", "residence_cities", "peak_day_cities"]) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_backup_${t}"`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "_backup_${t}" AS SELECT * FROM "${t}"`);
    const n = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) AS c FROM "_backup_${t}"`);
    console.log(`_backup_${t}: ${Number(n[0].c)} rows`);
  }
  console.log("\nBackups created. Drop them with DROP TABLE _backup_<name> once verified.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
