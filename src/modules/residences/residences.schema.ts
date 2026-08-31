import { z } from "zod";
import { RESIDENCE_TYPES } from "@/lib/residenceType";

export const residenceIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
});

export const hostIdParamSchema = z.object({
  params: z.object({ hostId: z.coerce.number().int() }),
});

export const createResidenceSchema = z.object({
  body: z.object({
    type: z.enum(RESIDENCE_TYPES),
    name: z.string().min(1).max(200).optional(),
    cityId: z.number().int().optional(),
    // The wizard's address step knows the city only by the name the host
    // picked. It used to look the id up with its own request before this one,
    // which put a second serial round trip in front of every address save.
    cityName: z.string().max(200).optional(),
  }),
});

export const updateSpecsSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    name: z.string().min(2).max(200).optional(),
    name2: z.string().max(200).optional(),
    // "نام پیشنهادی میزبان" — kept alongside the published `name`
    hostSuggestedName: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    region: z.string().max(200).optional(),
    rentType: z.string().max(200).optional(),
    address: z.string().max(500).optional(),
    // "آدرس در فاکتور" — full postal address, invoices only
    invoiceAddress: z.string().max(500).optional(),
    neighborhood: z.string().max(200).optional(),
    cityId: z.number().int().optional(),
    // "نوع ملک" — admin can retype from the detail page
    type: z.enum(RESIDENCE_TYPES).optional(),
    // "اهمیت اقامتگاه" — manual search-ranking weight
    importance: z.number().int().min(0).optional(),
    floor: z.string().optional(),
    foundationArea: z.number().optional(),
    totalArea: z.number().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    step: z.number().int().min(0).max(14).optional(), // wizard progress marker, never moves backward
  }),
});

export const updateAmenitiesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    amenities: z.array(
      z.object({
        amenityId: z.number().int(),
        /**
         * The stored shape is `{ value, extra }` — `value` a string on 150,073
         * rows, `extra` a nested object of sub-answers on 9,969.
         *
         * This was a flat `record(string|number|boolean)`, which rejected
         * `extra` outright: saving any amenity carrying sub-answers — a pool,
         * a parking space, a bathroom — failed the whole request with
         * «ورودی نامعتبر است», and one such amenity blocked the save for every
         * other one in the same list.
         *
         * `passthrough` because the migrated JSON is not ours to prune: an
         * unknown key from Odoo should survive a round trip, not be silently
         * dropped by a validator.
         */
        extraFeatures: z
          .object({
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
          })
          .passthrough()
          .optional(),
      })
    ),
    other: z.string().optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
    /**
     * The amenity ids this editor is responsible for. Anything outside the
     * scope is left alone — see `updateAmenities`. Omitted by the wizard,
     * which submits the whole answer and means to replace it.
     */
    scopeIds: z.array(z.number().int()).optional(),
  }),
});

export const updateRulesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    rules: z
      .array(
        z.object({
          ruleId: z.number().int(),
          value: z.unknown().optional(),
        })
      )
      .optional(),
    checkinFrom: z.string().optional(),
    checkinTo: z.string().optional(),
    checkout: z.string().optional(),
    minReservableDays: z.number().int().optional(),
    rulesDesc: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDesc: z.string().optional(),
    fullReturnTime: z.number().int().optional(),
    beforeStartTime: z.number().int().optional(),
    hostShareTotalAmount: z.number().optional(),
    hostSharePastNights: z.number().optional(),
    hostShareFutureNights: z.number().optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const updatePricingSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    weekPrice: z.number().min(0).optional(),
    weekendPrice: z.number().min(0).optional(),
    peakPrice: z.number().min(0).optional(),
    extraPrice: z.number().min(0).optional(),
    extraGuestsPrice: z.number().min(0).optional(),
    // "نرخ نفر اضافه ( ایام پیک )"
    extraGuestsPeakPrice: z.number().min(0).optional(),
    weeklyDiscount: z.number().min(0).max(100).optional(),
    monthlyDiscount: z.number().min(0).max(100).optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const updateCapacitySchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    capacity: z.number().int().optional(),
    maxCapacity: z.number().int().optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const changeStateSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    action: z.enum(["activate", "deactivate", "delete", "submit"]),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const roomSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  capacity: z.number().int().optional(),
  maxCapacity: z.number().int().optional(),
  singleBed: z.number().int().min(0).optional(),
  doubleBed: z.number().int().min(0).optional(),
  traditionalBed: z.number().int().min(0).optional(),
  extraBeds: z.number().int().min(0).optional(),
  weekPrice: z.number().min(0).optional(),
  weekendPrice: z.number().min(0).optional(),
  peakPrice: z.number().min(0).optional(),
  extraPrice: z.number().min(0).optional(),
  extraPeakPrice: z.number().min(0).optional(),
  weeklyDiscount: z.number().min(0).max(100).optional(),
  monthlyDiscount: z.number().min(0).max(100).optional(),
  coolingSystem: z.boolean().optional(),
  heatingSystem: z.boolean().optional(),
  refrigerator: z.enum(["NONE", "SHARED", "DEDICATED"]).optional(),
  wc: z.enum(["NONE", "SHARED", "DEDICATED"]).optional(),
  separateBathroom: z.boolean().optional(),
  freeBreakfast: z.boolean().optional(),
});

export const createRoomSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: roomSchema,
});

export const updateRoomSchema = z.object({
  params: z.object({ roomId: z.coerce.number().int() }),
  body: roomSchema.partial(),
});

// Wizard step 5 always resends the whole room list at once — replace-all is
// simpler and more robust here than diffing against existing rows by id.
export const replaceRoomsSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    capacity: z.number().int().optional(),
    maxCapacity: z.number().int().optional(),
    rooms: z.array(roomSchema),
  }),
});

export const reorderImagesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({ imageIds: z.array(z.number().int()) }),
});

/**
 * Editing one photo. Every field optional so the caller can send just the one
 * that changed — `isMain: true` promotes it and demotes whatever held the flag.
 */
export const updateImageSchema = z.object({
  params: z.object({
    id: z.coerce.number().int(),
    imageId: z.coerce.number().int(),
  }),
  body: z.object({
    title: z.string().max(200).nullable().optional(),
    alt: z.string().max(300).nullable().optional(),
    isMain: z.boolean().optional(),
  }),
});
