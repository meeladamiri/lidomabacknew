import { z } from "zod";
import { RESIDENCE_TYPES } from "@/lib/residenceType";

export const citySearchSchema = z.object({
  query: z.object({
    q: z.string().min(1).max(100),
  }),
});

export const legacyRedirectSchema = z.object({
  query: z.object({
    path: z.string().min(1).max(500),
  }),
});

export const searchPageDataSchema = z.object({
  query: z.object({
    slug: z.string().min(1).max(200),
    // comma-separated tag keys (?pool=1 pages send tags=pool) — the first
    // recognized one defines the page's SEO identity
    tags: z.string().max(300).optional(),
  }),
});

export const legacyImageSchema = z.object({
  query: z.object({
    model: z.enum(["product.image", "product.template"]),
    id: z.string().regex(/^\d+$/),
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
    type: z.enum(RESIDENCE_TYPES).optional(),
    features: z.array(z.string().max(50)).max(20).optional(),
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
