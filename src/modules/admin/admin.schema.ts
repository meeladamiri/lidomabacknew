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

const userProfileFields = {
  name: z.string().max(120).optional(),
  email: z.string().email().max(180).optional().or(z.literal("")),
  nationalCode: z.string().max(20).optional(),
  contactPhone: z.string().max(30).optional(),
  emergencyPhone: z.string().max(30).optional(),
  address: z.string().max(500).optional(),
  job: z.string().max(120).optional(),
  education: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  birthDay: z.coerce.number().int().min(1).max(31).optional(),
  birthMonth: z.coerce.number().int().min(1).max(12).optional(),
  birthYear: z.coerce.number().int().min(1200).max(1500).optional(),
  cityId: z.coerce.number().int().nullable().optional(),
};

export const updateUserSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    isHost: z.boolean().optional(),
    isActive: z.boolean().optional(),
    isSpecialHost: z.boolean().optional(),
    // کمیسیون میزبان (درصد). Null clears it, putting the host back on the
    // site-wide rate — which is not the same as setting it to zero.
    commissionPercent: z.number().min(0).max(100).nullable().optional(),
    role: z.enum(["USER", "ADMIN"]).optional(),
    verificationStatus: z.enum(["NOT_CONFIRMED", "CHECKING", "CONFIRMED"]).optional(),
    ...userProfileFields,
  }),
});

export const createUserSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^09\d{9}$/, "شماره موبایل معتبر نیست"),
    isHost: z.boolean().optional(),
    password: z.string().min(6).max(72).optional(),
    ...userProfileFields,
  }),
});

export const setPasswordSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({ password: z.string().min(6).max(72) }),
});

export const yellowCardSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({ reason: z.string().min(1).max(1000) }),
});

export const residenceListQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    q: z.string().optional(),
    state: z.string().optional(),
    tab: z.enum(["all", "suit", "boomgardi", "hotel", "pending"]).optional(),
    sort: z
      .enum(["newest", "oldest", "price_asc", "price_desc", "importance", "rating"])
      .optional(),
    filters: z.string().optional(),
  }),
});

// Multi-select actions on the residence list.
export const bulkIdsSchema = z.object({
  body: z.object({ ids: z.array(z.coerce.number().int()).min(1).max(500) }),
});

export const bulkStateSchema = z.object({
  body: z.object({
    ids: z.array(z.coerce.number().int()).min(1).max(500),
    state: z.enum(["DRAFT", "PENDING", "PUBLISHED", "REJECTED", "DEACTIVATED", "DELETED"]),
  }),
});

export const bulkTypeSchema = z.object({
  body: z.object({
    ids: z.array(z.coerce.number().int()).min(1).max(500),
    type: z.enum(["SUIT", "BOOMGARDI", "HOTEL"]),
  }),
});

export const distancesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    distances: z
      .array(
        z.object({
          placeName: z.string().min(1).max(200),
          distance: z.string().max(100).optional(),
          eta: z.string().max(100).optional(),
        })
      )
      .max(50),
  }),
});

export const extraCitiesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({ cityIds: z.array(z.coerce.number().int()).max(50) }),
});

export const userListQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    q: z.string().optional(),
    tab: z.enum(["all", "hosts", "guests", "admins"]).optional(),
    isActive: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    verificationStatus: z.enum(["NOT_CONFIRMED", "CHECKING", "CONFIRMED"]).optional(),
    sort: z.enum(["newest", "oldest", "reservations", "name"]).optional(),
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

/**
 * Moving one booking's deadline. Either an absolute moment or "n minutes from
 * now" — the two ways people actually ask for it are "until 6pm" and "give
 * them another hour".
 */
/**
 * A cancellation from the panel, with every lever support actually has.
 *
 * `justified` and `withoutPayback` are the two that move real money and neither
 * is available to a guest or a host cancelling their own booking — support
 * decides those, which is what stops the penalty ladder being a suggestion.
 */
export const changeStateSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    // CANCEL is accepted here only so the service can answer with a sentence
    // that says where to go instead. Leaving it out of the enum produced a
    // generic "invalid input", which tells the operator nothing.
    toState: z.enum(["DRAFT", "HOST_APPROVAL", "SECOND_PAYMENT", "DONE", "EXPIRED", "CANCEL"]),
    // Required by the schema, not just the form: the audit line is the whole
    // reason this endpoint exists, and an optional reason is one left empty.
    note: z.string().min(3).max(1000),
  }),
});

export const adminCancelSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    cancelledBy: z.enum(["HOST_CANCELLED", "GUEST_CANCELLED", "LIDOMA_CANCELLED"]),
    reason: z.string().min(1).max(500),
    desc: z.string().max(2000).nullable().optional(),
    justified: z.boolean().optional(),
    withoutPayback: z.boolean().optional(),
    coordinatedWith: z.enum(["guest", "host"]).nullable().optional(),
    notifyMode: z.enum(["BOTH", "ONLY_GUEST", "ONLY_HOST", "NONE"]).optional(),
    penaltyOverride: z.number().min(0).nullable().optional(),
  }),
});

/** The same options, but only to preview the money. */
export const cancelQuoteSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  query: z.object({
    cancelledBy: z.enum(["HOST_CANCELLED", "GUEST_CANCELLED", "LIDOMA_CANCELLED"]).optional(),
    justified: z.coerce.boolean().optional(),
    withoutPayback: z.coerce.boolean().optional(),
    penaltyOverride: z.coerce.number().min(0).optional(),
  }),
});

export const setReservationExpirySchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z
    .object({
      expiryDate: z.coerce.date().nullable().optional(),
      minutesFromNow: z.number().int().min(1).max(10_080).optional(),
    })
    .refine(
      (b) => b.minutesFromNow != null || b.expiryDate !== undefined,
      "مهلت جدید مشخص نشده است"
    ),
});

export const upsertAmenitySchema = z.object({
  body: z.object({
    key: z.string().max(60).optional(), // stable English identifier (search-tag filters match on it)
    category: z.string().optional(),
    name: z.string().min(1),
    iconUrl: z.string().optional(),
    // sub-feature definitions ("توضیحات بیشتر" form fields) — replaced
    // wholesale when provided
    features: z
      .array(
        z.object({
          fieldType: z.enum(["TEXT", "DROPDOWN", "SWITCH", "CHECKBOX"]),
          name: z.string().min(1),
          placeholder: z.string().nullable().optional(),
          values: z.string().nullable().optional(), // comma-separated options
          inFilter: z.boolean().optional(),
        })
      )
      .optional(),
  }),
});

export const upsertRuleSchema = z.object({
  body: z.object({
    key: z.string().max(60).optional(),
    category: z.string().optional(),
    name: z.string().min(1),
    iconUrl: z.string().optional(),
  }),
});

export const upsertPeakDaySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    startDate: z.string(),
    endDate: z.string(),
    isActive: z.boolean().optional(),
    // empty/absent = nationwide
    cityIds: z.array(z.coerce.number().int()).optional(),
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
