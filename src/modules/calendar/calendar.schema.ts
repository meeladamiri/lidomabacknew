import { z } from "zod";
import { numeric } from "@/modules/residences/numeric";

export const getCalendarSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  query: z.object({
    roomId: z.coerce.number().int().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export const updateCalendarSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    roomId: numeric(z.number().int()).optional(),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    isBlocked: z.boolean().optional(),
    isFast: z.boolean().optional(),
    // A price typed into a text input arrives as a string — see numeric.ts.
    // This schema was missed when the same fix went into residences.schema,
    // so entering a rate on the calendar failed with «ورودی نامعتبر است».
    specialPrice: numeric(z.number().min(0)).optional(),
    discountAmount: numeric(z.number().min(0)).optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_PRICE"]).optional(),
    reset: z.boolean().optional(), // clears overrides for the given dates
  }),
});
