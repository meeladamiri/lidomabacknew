import { z } from "zod";

const phoneSchema = z
  .string()
  .regex(/^09\d{9}$/, "شماره موبایل معتبر نیست (مثال: 09123456789)");

export const requestOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    code: z.string().min(4).max(8),
    name: z.string().min(2).max(120).optional(), // optional display name on first signup
  }),
});

export const passwordLoginSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    password: z.string().min(6),
  }),
});

export const setPasswordSchema = z.object({
  body: z.object({
    password: z.string().min(6),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10),
  }),
});
