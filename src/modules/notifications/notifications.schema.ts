import { z } from "zod";

export const listNotificationsSchema = z.object({
  query: z.object({
    // Query strings are text; "true"/"1" both mean archived.
    archived: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
    cursor: z.coerce.number().int().positive().optional(),
    take: z.coerce.number().int().min(1).max(50).optional(),
  }),
});

export const markReadSchema = z.object({
  body: z.object({
    // Omitted means "everything unread".
    ids: z.array(z.number().int().positive()).max(200).optional(),
  }),
});

export const notificationIdSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const archiveSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    archived: z.boolean().optional(),
  }),
});
