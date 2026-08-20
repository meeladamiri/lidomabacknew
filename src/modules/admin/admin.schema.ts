import { z } from "zod";

export const listQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    q: z.string().optional(),
    state: z.string().optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
});

export const updateUserSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    isHost: z.boolean().optional(),
    role: z.enum(["USER", "ADMIN"]).optional(),
    verificationStatus: z.enum(["NOT_CONFIRMED", "CHECKING", "CONFIRMED"]).optional(),
  }),
});

export const residenceStateSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    state: z.enum(["DRAFT", "PENDING", "PUBLISHED", "REJECTED", "DEACTIVATED", "DELETED"]),
  }),
});

export const upsertAmenitySchema = z.object({
  body: z.object({
    category: z.string().optional(),
    name: z.string().min(1),
    iconUrl: z.string().optional(),
  }),
});

export const upsertRuleSchema = z.object({
  body: z.object({
    category: z.string().optional(),
    name: z.string().min(1),
    iconUrl: z.string().optional(),
  }),
});

export const upsertCitySchema = z.object({
  body: z.object({
    name: z.string().min(1),
    provinceId: z.number().int().optional(),
    titleEn: z.string().optional(),
    imageUrl: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
});

export const upsertProvinceSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
});
