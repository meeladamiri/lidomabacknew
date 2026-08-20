import { z } from "zod";

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
    roomId: z.number().int().optional(),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    isBlocked: z.boolean().optional(),
    isFast: z.boolean().optional(),
    specialPrice: z.number().min(0).optional(),
    discountAmount: z.number().min(0).optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_PRICE"]).optional(),
    reset: z.boolean().optional(), // clears overrides for the given dates
  }),
});
