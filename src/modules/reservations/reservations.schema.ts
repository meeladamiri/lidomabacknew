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

// Guests pick from a free-text, multi-select list of reasons in the UI (not the
// fixed host-side category system), so this only requires a non-empty string.
export const guestCancelReservationSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    reason: z.string().min(1).optional(),
  }),
});

const score = z.number().int().min(1).max(5);

export const submitReviewSchema = z.object({
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({
    cleaning: score,
    location: score,
    quality: score,
    integrity: score,
    greeting: score,
    delivery: score,
    comment: z.string().min(1).max(2000),
  }),
});

export const reviewIdParamSchema = z.object({
  params: z.object({ reviewId: z.coerce.number().int() }),
});

export const replyToReviewSchema = z.object({
  params: z.object({ reviewId: z.coerce.number().int() }),
  body: z.object({
    hostAnswer: z.string().min(1).max(2000),
  }),
});
