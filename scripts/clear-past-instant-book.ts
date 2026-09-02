/**
 * Clears instant-book flags on dates that have already passed.
 *
 * The flag decides whether a booking for that night confirms without host
 * approval, so on a night nobody can book it decides nothing. Rows left saying
 * nothing at all are then deleted; rows carrying a price or a discount are
 * kept, because that is the rate a guest actually paid.
 *
 * Dry by default. Pass --commit to write.
 */
import { PrismaClient } from "@prisma/client";
import { clearPastInstantBook } from "@/modules/calendar/calendar.service";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");

(async () => {
  const today = new Date(new Date().toISOString().slice(0, 10));

  const withFlag = await prisma.calendarDay.count({
    where: { date: { lt: today }, isFast: { not: null } },
  });
  const wouldEmpty = await prisma.calendarDay.count({
    where: {
      date: { lt: today },
      isBlocked: false,
      isPeak: false,
      specialPrice: null,
      discountAmount: null,
    },
  });
  const priced = await prisma.calendarDay.count({
    where: {
      date: { lt: today },
      OR: [{ specialPrice: { not: null } }, { discountAmount: { not: null } }],
    },
  });

  console.log(`past rows carrying an instant-book flag : ${withFlag}`);
  console.log(`  ...of which would then be empty       : ${wouldEmpty}  (deleted)`);
  console.log(`past rows carrying a price or discount  : ${priced}  (kept)`);

  if (!commit) {
    console.log("\ndry run — pass --commit to apply");
  } else {
    const result = await clearPastInstantBook();
    console.log(`\ncleared flags: ${result.cleared}   deleted empty rows: ${result.removed}`);
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error(String(e).slice(0, 300));
  process.exit(1);
});
