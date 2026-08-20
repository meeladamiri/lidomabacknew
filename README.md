# Lidoma Backend (Phase 1)

Express + TypeScript + Prisma (PostgreSQL) backend rebuilding the parts of the
LidomaTrip platform that are already implemented in the Next.js frontend:
auth, residence/room listings, amenities & rules, calendar & pricing, search,
reservations, favourites, host self-service, and an admin API.

**Not included yet (phase 2, by earlier agreement):** wallet, host
payouts/settlements, order-scoped chat, reviews, complaints/contact form,
support chat, vouchers/coupons. The schema and module structure are set up so
these can be added without reshaping what's already here.

## Important: this was written without a working internet connection

The sandbox this was built in could not reach `registry.npmjs.org` (network
policy), so **none of this has been `npm install`-ed, type-checked, or run**.
The code follows standard, well-tested Express/Prisma/TypeScript patterns,
but you must treat first-run as an integration/testing pass, not just a
formality — run through the checklist below and fix anything TypeScript or
Prisma complains about before relying on it.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` (point it at your
   PostgreSQL instance — the "clean new schema" you asked for, not the old
   Odoo database) plus JWT secrets and, when ready, real SMS provider
   credentials for OTP.
3. `npm run prisma:migrate` — creates the database tables from
   `prisma/schema.prisma` (name the migration `init` when prompted).
4. `npm run seed` — creates an admin user (from `ADMIN_BOOTSTRAP_PHONE` /
   `ADMIN_BOOTSTRAP_PASSWORD` in `.env`), a couple of provinces/cities, an
   amenity/rule, and one sample published residence you can search for and
   book, so you can smoke-test the whole flow immediately.
5. `npm run dev` — starts the API on `http://localhost:4000` (see `PORT` in
   `.env`).
6. Sanity checklist before trusting this in any real environment:
   - `npx tsc --noEmit` — 0 type errors.
   - `curl -X POST http://localhost:4000/api/auth/otp/request -H "Content-Type: application/json" -d '{"phone":"09121111111"}'`
     — should log the OTP code to the console (no SMS provider configured
     yet) and return `{status:"success", data:{exists:true, ttlSeconds:120}}`.
   - `curl -X POST http://localhost:4000/api/search/residences -H "Content-Type: application/json" -d '{}'`
     — should return the seeded sample residence.
   - Log in as the seeded admin via `POST /api/auth/login/password` with
     `ADMIN_BOOTSTRAP_PHONE` / `ADMIN_BOOTSTRAP_PASSWORD`, then hit
     `GET /api/admin/dashboard/stats` with the returned `accessToken` as a
     Bearer token.

## Project layout

```
prisma/schema.prisma      the whole data model, phase 1 scope (see comment at top)
prisma/seed.ts             admin user + sample data
src/config/env.ts          all environment variables in one typed object
src/lib/                   prisma client, jwt, otp, error class
src/middleware/            auth guards, validation (zod), error handler, multer upload
src/modules/
  auth/                    OTP request/verify, password login, refresh, /me
  users/                   profile + bank account (self-service)
  residences/              public detail + host CRUD (specs/amenities/rules/pricing/rooms/images)
  calendar/                availability + pricing overrides, public read + host write
  search/                  city/province search, popular destinations, residence search
  reservations/            guest booking flow + host accept/reject/cancel
  favourites/               wishlist
  admin/                   dashboard stats, users/residences/reservations management,
                            amenity/rule/city/province catalog CRUD
src/app.ts / src/server.ts wiring + entrypoint
```

## Design notes worth knowing about

- **Auth is OTP-first**, matching the frontend's `enter_phone → otp` flow:
  `POST /api/auth/otp/request` sends a code (logged to console until you wire
  a real SMS provider in `src/lib/otp.ts`), `POST /api/auth/otp/verify`
  verifies it and creates the user on first use, returning a JWT access +
  refresh token pair. Password login (`/api/auth/login/password`) is
  available as an alternative for users who set a password (`/api/auth/password`,
  authenticated) — mirrors the frontend's `login-enter_password` screen.
- **The old Odoo backend reused one `/api/update_calendar` controller** for
  blocking dates, the instant-book ("fast") flag, and Nowruz seasonal
  pricing, distinguished only by which params were sent. This rebuild
  normalizes all three into one `CalendarDay` table with explicit columns
  (`isBlocked`, `isFast`, `specialPrice`, `discountType`) — see
  `src/modules/calendar/`.
- **Pricing calculation** (`src/modules/reservations/pricing.ts`) is a
  from-scratch reimplementation, not extracted from the old Odoo code (I
  didn't have that source). It handles weekday/weekend/peak pricing and
  weekly/monthly discounts night-by-night. Iran's weekend is hardcoded as
  Thursday+Friday — check this matches the business's actual rule, and treat
  the whole function as something to validate against known-good bookings
  from the old system before going live, not as ground truth.
- **File uploads** (`src/middleware/upload.ts`) write to a local `uploads/`
  folder and serve it statically. Fine for development; swap the multer
  storage engine for S3/Liara Object Storage/etc. before production so
  uploaded images survive redeploys.
- **CalendarDay uniqueness caveat**: see the comment directly above
  `@@unique([residenceId, roomId, date])` in `schema.prisma` — Postgres does
  not enforce uniqueness across NULL `roomId` values, so there's a narrow
  concurrent-write edge case. Not an issue for normal single-host usage;
  flagged so it doesn't surprise anyone later.
- **`@/` import aliases**: resolved automatically in dev via `tsx` (which
  reads `tsconfig.json`'s `paths`), and rewritten to relative paths at build
  time via `tsc-alias` (see the `build` script). If you ever swap the build
  tooling, re-check that this still works — it's a common footgun with
  path aliases + plain `tsc`.
- Money fields are stored as `Float` for simplicity — if precise accounting
  matters (it will, once payments are real), migrate these to `Decimal`
  before going live.

## What's deliberately not here yet

Wallet balances/transactions, host payout & settlement workflows, the
order-scoped chat between guest and host, the review/rating system,
complaints/contact-form submissions, the separate support chat, and
vouchers/coupons. All of these showed up in the frontend inventory but were
scoped to phase 2. Adding them means: new Prisma models (sketched out during
planning, not yet written), new `src/modules/*` folders following the same
pattern as the ones here, and — for wallet/payouts specifically — a real
payment gateway integration, which needs your input on which gateway to use.
