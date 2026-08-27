import { Prisma, PrismaClient } from "@prisma/client";

const IRAN_WEEKEND_DAYS = new Set([4, 5]); // Thursday(4), Friday(5) — adjust if the business defines this differently

export interface StayPricingInput {
  residence: {
    weekPrice: number | null;
    weekendPrice: number | null;
    peakPrice: number | null;
    extraGuestsPrice: number | null;
    weeklyDiscount: number | null;
    monthlyDiscount: number | null;
  };
  calendarOverrides: { date: Date; specialPrice: number | null; isPeak: boolean }[];
  startDate: Date;
  endDate: Date; // exclusive (checkout date)
  extraGuestsCount: number;
}

export interface StayPricingResult {
  nights: number;
  nightlyBreakdown: { date: string; unitPrice: number; isWeekend: boolean; isPeak: boolean; isSpecial: boolean }[];
  subtotal: number;
  extraGuestsTotal: number;
  discountPercent: number;
  discountAmount: number;
  totalAmount: number;
}

export function calculateStayPrice(input: StayPricingInput): StayPricingResult {
  const overridesByDate = new Map(
    input.calendarOverrides.map((o) => [o.date.toISOString().slice(0, 10), o])
  );

  const nightlyBreakdown: StayPricingResult["nightlyBreakdown"] = [];
  let cursor = new Date(input.startDate);
  let subtotal = 0;

  while (cursor < input.endDate) {
    const dateKey = cursor.toISOString().slice(0, 10);
    const override = overridesByDate.get(dateKey);
    const isWeekend = IRAN_WEEKEND_DAYS.has(cursor.getUTCDay());
    const isPeak = override?.isPeak ?? false;

    let unitPrice =
      isPeak && input.residence.peakPrice
        ? input.residence.peakPrice
        : isWeekend && input.residence.weekendPrice
          ? input.residence.weekendPrice
          : (input.residence.weekPrice ?? 0);

    const isSpecial = Boolean(override?.specialPrice);
    if (override?.specialPrice) {
      unitPrice = override.specialPrice;
    }

    nightlyBreakdown.push({ date: dateKey, unitPrice, isWeekend, isPeak, isSpecial });
    subtotal += unitPrice;

    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  const nights = nightlyBreakdown.length;
  const extraGuestsTotal = (input.residence.extraGuestsPrice ?? 0) * input.extraGuestsCount * nights;

  let discountPercent = 0;
  if (nights >= 30 && input.residence.monthlyDiscount) {
    discountPercent = input.residence.monthlyDiscount;
  } else if (nights >= 7 && input.residence.weeklyDiscount) {
    discountPercent = input.residence.weeklyDiscount;
  }

  const discountAmount = ((subtotal + extraGuestsTotal) * discountPercent) / 100;
  const totalAmount = subtotal + extraGuestsTotal - discountAmount;

  return {
    nights,
    nightlyBreakdown,
    subtotal,
    extraGuestsTotal,
    discountPercent,
    discountAmount,
    totalAmount: Math.round(totalAmount),
  };
}

export type ResidencePricingFields = Prisma.ResidenceGetPayload<{
  select: {
    weekPrice: true;
    weekendPrice: true;
    peakPrice: true;
    extraGuestsPrice: true;
    weeklyDiscount: true;
    monthlyDiscount: true;
  };
}>;
