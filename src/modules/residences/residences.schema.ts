import { z } from "zod";
import { RESIDENCE_TYPES } from "@/lib/residenceType";
import { numeric } from "./numeric";

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
    cityId: numeric(z.number().int()).optional(),
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
    cityId: numeric(z.number().int()).optional(),
    /**
     * The city by name, which is how the wizard's address step knows it.
     *
     * It was missing here while both the wizard and `updateSpecs` were written
     * for it: the front sent `cityName`, zod stripped it as an unknown key,
     * and the service never saw the field whose lookup it implements. So
     * choosing a city wrote nothing, on either version of the wizard — the
     * request returned 200 and the listing stayed in no city at all.
     */
    cityName: z.string().max(200).optional(),
    // "نوع ملک" — admin can retype from the detail page
    type: z.enum(RESIDENCE_TYPES).optional(),
    // "اهمیت اقامتگاه" — manual search-ranking weight
    importance: numeric(z.number().int().min(0)).optional(),
    /**
     * «رزرو آنی» — whether a booking confirms without the host approving it.
     *
     * One boolean on the listing, which is the whole answer for almost every
     * host. A single date can still differ, but that is stored as an override
     * on that date only — see calendar.service.
     */
    isFast: z.boolean().optional(),
    floor: z.string().optional(),
    foundationArea: numeric(z.number().min(0)).optional(),
    totalArea: numeric(z.number().min(0)).optional(),
    latitude: numeric(z.number().min(-90).max(90)).optional(),
    longitude: numeric(z.number().min(-180).max(180)).optional(),
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
    minReservableDays: numeric(z.number().int().min(1)).optional(),
    rulesDesc: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDesc: z.string().optional(),
    fullReturnTime: numeric(z.number().int().min(0)).optional(),
    beforeStartTime: numeric(z.number().int().min(0)).optional(),
    hostShareTotalAmount: numeric(z.number().min(0).max(100)).optional(),
    hostSharePastNights: numeric(z.number().min(0).max(100)).optional(),
    hostShareFutureNights: numeric(z.number().min(0).max(100)).optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const updatePricingSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    weekPrice: numeric(z.number().min(0)).optional(),
    weekendPrice: numeric(z.number().min(0)).optional(),
    peakPrice: numeric(z.number().min(0)).optional(),
    extraPrice: numeric(z.number().min(0)).optional(),
    extraGuestsPrice: numeric(z.number().min(0)).optional(),
    // "نرخ نفر اضافه ( ایام پیک )"
    extraGuestsPeakPrice: numeric(z.number().min(0)).optional(),
    weeklyDiscount: numeric(z.number().min(0).max(100)).optional(),
    monthlyDiscount: numeric(z.number().min(0).max(100)).optional(),
    // Wizard progress, folded into this write so the front does not need a
    // second PATCH to advance it. Never moves backward — see stepPatch.
    step: z.number().int().min(0).max(14).optional(),
  }),
});

export const updateCapacitySchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    capacity: numeric(z.number().int().min(0)).optional(),
    maxCapacity: numeric(z.number().int().min(0)).optional(),
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
  capacity: numeric(z.number().int().min(0)).optional(),
  maxCapacity: numeric(z.number().int().min(0)).optional(),
  singleBed: numeric(z.number().int().min(0)).optional(),
  doubleBed: numeric(z.number().int().min(0)).optional(),
  traditionalBed: numeric(z.number().int().min(0)).optional(),
  extraBeds: numeric(z.number().int().min(0)).optional(),
  weekPrice: numeric(z.number().min(0)).optional(),
  weekendPrice: numeric(z.number().min(0)).optional(),
  peakPrice: numeric(z.number().min(0)).optional(),
  extraPrice: numeric(z.number().min(0)).optional(),
  extraPeakPrice: numeric(z.number().min(0)).optional(),
  weeklyDiscount: numeric(z.number().min(0).max(100)).optional(),
  monthlyDiscount: numeric(z.number().min(0).max(100)).optional(),
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
    capacity: numeric(z.number().int().min(0)).optional(),
    maxCapacity: numeric(z.number().int().min(0)).optional(),
    rooms: z.array(roomSchema),
  }),
});

export const reorderImagesSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    imageIds: z.array(z.number().int()),
    // Sent by the wizard and silently stripped until now, so the listing's
    // progress marker stood still on this step.
    step: numeric(z.number().int()),
  }),
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

/**
 * One classification answer.
 *
 * Multi-valued because the data is: listings carrying «شهری، ساحلی» are real,
 * and the tag engine matches any one of the values.
 */
export const classificationBodySchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    key: z.enum(["type", "area"]),
    values: z.array(z.string().max(80)).max(10),
  }),
});
