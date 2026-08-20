import { z } from "zod";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createReservationSchema = z.object({
  body: z.object({
    residenceId: z.number().int(),
    roomIds: z.array(z.number().int()).optional(),
    startDate: dateStr,
    endDate: dateStr,
    guestsCount: z.number().int().min(1),
    extraGuestsCount: z.number().int().min(0).optional(),
    guestNameOverride: z.string().optional(),
    guestPhoneOverride: z.string().optional(),
  }),
});

export const reservationIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
});

export const rejectReservationSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    reason: z.enum(["no_vacancy", "not_ready", "price_changed", "other"]),
    desc: z.string().optional(),
  }),
});

export const cancelReservationSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    reason: z.enum(["guest_delay", "not_ready", "already_reserved", "other"]).optional(),
    desc: z.string().optional(),
  }),
});
