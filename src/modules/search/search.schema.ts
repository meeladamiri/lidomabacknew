import { z } from "zod";

export const citySearchSchema = z.object({
  query: z.object({
    q: z.string().min(1).max(100),
  }),
});

export const residenceSearchSchema = z.object({
  body: z.object({
    cityId: z.number().int().optional(),
    cityName: z.string().optional(),
    startDate: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    endDate: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    guestsCount: z.number().int().min(1).optional(),
    roomsCount: z.number().int().min(1).optional(),
    minPrice: z.number().min(0).optional(),
    maxPrice: z.number().min(0).optional(),
    type: z.enum(["BOOMGARDI", "SUIT"]).optional(),
    mapBounds: z
      .object({
        minLat: z.number(),
        maxLat: z.number(),
        minLng: z.number(),
        maxLng: z.number(),
      })
      .optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
    order: z.enum(["price_asc", "price_desc", "rating_desc", "newest"]).optional(),
  }),
});
