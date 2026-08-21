import { z } from "zod";

export const listQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    q: z.string().optional(),
    state: z.string().optional(),
    // JSON-encoded FilterCondition[] — parsed/whitelisted in admin.service.ts,
    // this schema only checks it's syntactically a string here.
    filters: z.string().optional(),
  }),
});

export const filterPresetSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    entity: z.string().min(1).max(50),
    filters: z.array(
      z.object({ field: z.string(), operator: z.string(), value: z.unknown() })
    ),
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

export const updateReservationSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    action: z.enum(["cancel", "forceApprove", "markDone"]),
    reason: z.string().max(500).optional(),
    desc: z.string().max(2000).optional(),
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
