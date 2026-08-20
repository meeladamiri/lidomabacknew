import { PrismaClient } from "@/generated/prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const adminPhone = process.env.ADMIN_BOOTSTRAP_PHONE ?? "09120000000";
  const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "ChangeMe123!";

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.user.upsert({
    where: { phone: adminPhone },
    create: {
      phone: adminPhone,
      name: "Admin",
      role: "ADMIN",
      verificationStatus: "CONFIRMED",
      passwordHash,
    },
    update: { role: "ADMIN", passwordHash },
  });
  console.log(`Admin user ready: ${admin.phone} (password from ADMIN_BOOTSTRAP_PASSWORD)`);

  const tehran = await prisma.province.upsert({
    where: { id: 1 },
    create: { id: 1, name: "تهران" },
    update: {},
  });
  const mazandaran = await prisma.province.upsert({
    where: { id: 2 },
    create: { id: 2, name: "مازندران" },
    update: {},
  });

  await prisma.city.upsert({
    where: { id: 1 },
    create: { id: 1, name: "تهران", provinceId: tehran.id, titleEn: "Tehran" },
    update: {},
  });
  const ramsar = await prisma.city.upsert({
    where: { id: 2 },
    create: { id: 2, name: "رامسر", provinceId: mazandaran.id, titleEn: "Ramsar" },
    update: {},
  });

  const wifiAmenity = await prisma.amenity.upsert({
    where: { id: 1 },
    create: { id: 1, category: "رفاهی", name: "اینترنت وای‌فای" },
    update: {},
  });
  await prisma.amenity.upsert({
    where: { id: 2 },
    create: { id: 2, category: "رفاهی", name: "پارکینگ" },
    update: {},
  });

  const noPetsRule = await prisma.rule.upsert({
    where: { id: 1 },
    create: { id: 1, category: "مقررات اقامتگاه", name: "حیوان خانگی ممنوع" },
    update: {},
  });

  // A sample host + published residence, useful for exercising the search/detail/reservation flow locally.
  const hostPassword = await bcrypt.hash("HostPass123!", 10);
  const host = await prisma.user.upsert({
    where: { phone: "09121111111" },
    create: {
      phone: "09121111111",
      name: "میزبان نمونه",
      isHost: true,
      passwordHash: hostPassword,
      verificationStatus: "CONFIRMED",
    },
    update: { isHost: true },
  });

  const existingSample = await prisma.residence.findFirst({ where: { reference: "RES-SEED0001" } });
  const sample =
    existingSample ??
    (await prisma.residence.create({
      data: {
        reference: "RES-SEED0001",
        hostId: host.id,
        type: "SUIT",
        state: "PUBLISHED",
        published: true,
        name: "سوئیت نمونه رامسر",
        description: "یک اقامتگاه نمونه برای تست جستجو و رزرو.",
        cityId: ramsar.id,
        capacity: 4,
        maxCapacity: 6,
        weekPrice: 1_500_000,
        weekendPrice: 2_200_000,
        peakPrice: 3_000_000,
        extraGuestsPrice: 200_000,
        weeklyDiscount: 5,
        monthlyDiscount: 15,
        images: { create: [{ url: "/uploads/sample.jpg", sortOrder: 0, isMain: true }] },
        amenities: { create: [{ amenityId: wifiAmenity.id }] },
        rules: { create: [{ ruleId: noPetsRule.id }] },
        rooms: {
          create: [
            {
              name: "اتاق اصلی",
              capacity: 4,
              maxCapacity: 6,
              doubleBed: 1,
              singleBed: 2,
              weekPrice: 1_500_000,
              weekendPrice: 2_200_000,
            },
          ],
        },
      },
    }));

  console.log(`Sample residence ready: #${sample.id} (${sample.reference})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
