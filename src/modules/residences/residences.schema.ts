import { z } from "zod";

export const residenceIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
});

export const createResidenceSchema = z.object({
  body: z.object({
    type: z.enum(["BOOMGARDI", "SUIT"]),
    name: z.string().min(1).max(200).optional(),
    cityId: z.number().int().optional(),
  }),
});

export const updateSpecsSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    name: z.string().min(2).max(200).optional(),
    description: z.string().max(5000).optional(),
    region: z.string().max(200).optional(),
    rentType: z.string().max(200).optional(),
    address: z.string().max(500).optional(),
    neighborhood: z.string().max(200).optional(),
    cityId: z.number().int().optional(),
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
        extraFeatures: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      })
    ),
    other: z.string().optional(),
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
    weeklyDiscount: z.number().min(0).max(100).optional(),
    monthlyDiscount: z.number().min(0).max(100).optional(),
  }),
});

export const updateCapacitySchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    capacity: z.number().int().optional(),
    maxCapacity: z.number().int().optional(),
  }),
});

export const changeStateSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    action: z.enum(["activate", "deactivate", "delete", "submit"]),
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
