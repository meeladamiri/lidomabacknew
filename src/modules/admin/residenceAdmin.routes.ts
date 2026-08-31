import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "@/middleware/asyncHandler";
import { validate } from "@/middleware/validate";
import { ok } from "@/utils/response";
import { rankInCity } from "./residenceRank.service";
import { changeHost } from "./residenceHost.service";
import {
  getClassification,
  setClassification,
  CLASSIFICATION_KEYS,
} from "./residenceClassification.service";
import { getStats } from "./residenceStats.service";
import { listForResidence, hideReview, unhideReview, answerReview } from "./reviews.service";
import { prisma } from "@/lib/prisma";
import { upload, fileToUrl, deleteStoredFile } from "@/middleware/upload";
import { AppError } from "@/lib/errors";
import * as activity from "@/modules/activity/activity.service";

/** Listing-level actions the detail page needs. Mounted under the admin router. */
const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Where this listing sits in its city's search results, and where it would sit
 * at a different «اهمیت». Read-only, so the panel can show the effect of a
 * number before it is saved.
 */
router.get(
  "/residences/:id/rank",
  validate(
    z.object({
      params: idParam,
      query: z.object({ importance: z.coerce.number().int().min(0).optional() }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const { importance } = req.query as unknown as { importance?: number };
    return ok(res, await rankInCity(id, importance));
  })
);

router.patch(
  "/residences/:id/host",
  validate(
    z.object({
      params: idParam,
      body: z.object({
        hostId: z.number().int().positive(),
        note: z.string().max(500).optional(),
        dryRun: z.boolean().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { hostId: number; note?: string; dryRun?: boolean };
    return ok(
      res,
      await changeHost({
        residenceId: id,
        newHostId: body.hostId,
        note: body.note ?? "",
        dryRun: body.dryRun,
        actorId: req.user!.sub,
      })
    );
  })
);

/**
 * «نوع اقامتگاه» و «منطقه اقامتگاه» — the two taxonomies the SEO tag pages
 * are built from. Read gives the options actually in use plus what this
 * listing answers; write touches only the one amenity.
 */
router.get(
  "/residences/:id/classification",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await getClassification(id));
  })
);

router.patch(
  "/residences/:id/classification",
  validate(
    z.object({
      params: idParam,
      body: z.object({
        key: z.enum(CLASSIFICATION_KEYS),
        values: z.array(z.string().max(80)).max(10),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { key: (typeof CLASSIFICATION_KEYS)[number]; values: string[] };
    return ok(
      res,
      await setClassification({ residenceId: id, ...body, actorId: req.user!.sub })
    );
  })
);

/**
 * آمار اقامتگاه — reservations, nights, income, reviews, favourites, views.
 *
 * The same service the host's own statistics page reads, so the two cannot
 * disagree about what a listing earned.
 */
router.get(
  "/residences/:id/stats",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await getStats({ residenceId: id }));
  })
);

// ---------------------------------------------------------------- نظرات

/**
 * Every review of this listing, hidden ones included.
 *
 * The panel is the one place that must see a hidden review — it is where the
 * decision to hide it is reviewed and, sometimes, reversed.
 */
router.get(
  "/residences/:id/reviews",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    return ok(res, await listForResidence(id, { includeHidden: true }));
  })
);

router.post(
  "/reviews/:reviewId/hide",
  validate(
    z.object({
      params: z.object({ reviewId: z.coerce.number().int().positive() }),
      // Required. "Why is this review not on the site" is the only question
      // anyone asks later, and it is asked by people who can see the row.
      body: z.object({ reason: z.string().trim().min(1).max(500) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await hideReview(reviewId, req.body.reason, req.user!.sub));
  })
);

router.post(
  "/reviews/:reviewId/unhide",
  validate(z.object({ params: z.object({ reviewId: z.coerce.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await unhideReview(reviewId, req.user!.sub));
  })
);

router.put(
  "/reviews/:reviewId/answer",
  validate(
    z.object({
      params: z.object({ reviewId: z.coerce.number().int().positive() }),
      body: z.object({ answer: z.string().trim().min(1).max(2000) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await answerReview(reviewId, req.body.answer, req.user!.sub));
  })
);

// --------------------------------------------------------- مدرک مالکیت

/**
 * The three identity and ownership files a listing carries.
 *
 * They live in columns on the residence rather than a table, because there is
 * exactly one of each and they answer three fixed questions: is this property
 * what the host says it is, is the host who they say they are, and — when the
 * host is not the owner — who is.
 */
const DOCUMENT_FIELDS = {
  document: "documentUrl",
  hostCard: "hostNationalCardUrl",
  ownerCard: "ownerNationalCardUrl",
} as const;

type DocumentKind = keyof typeof DOCUMENT_FIELDS;

/**
 * Rejects an unknown document kind before multer runs.
 *
 * Order matters here: multer stores the file as it parses the request, so
 * validating inside the handler means a bad kind has already uploaded a file
 * to object storage that nothing will ever reference or clean up.
 */
function requireDocumentKind(req: Request, _res: Response, next: NextFunction) {
  if (!(req.params.kind in DOCUMENT_FIELDS)) {
    return next(AppError.badRequest("نوع مدرک نامعتبر است"));
  }
  return next();
}

router.get(
  "/residences/:id/documents",
  validate(z.object({ params: idParam })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const residence = await prisma.residence.findUnique({
      where: { id },
      select: {
        documentUrl: true,
        hostNationalCardUrl: true,
        ownerNationalCardUrl: true,
        host: { select: { id: true, name: true, phone: true, verificationStatus: true } },
      },
    });
    if (!residence) throw AppError.notFound("اقامتگاه پیدا نشد");
    return ok(res, residence);
  })
);

router.post(
  "/residences/:id/documents/:kind",
  requireDocumentKind,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const kind = req.params.kind as DocumentKind;
    const field = DOCUMENT_FIELDS[kind];
    if (!field) throw AppError.badRequest("نوع مدرک نامعتبر است");
    if (!req.file) throw AppError.badRequest("فایلی ارسال نشد");

    const existing = await prisma.residence.findUnique({
      where: { id },
      select: { [field]: true } as never,
    });
    if (!existing) throw AppError.notFound("اقامتگاه پیدا نشد");

    const url = fileToUrl(req.file);
    await prisma.residence.update({ where: { id }, data: { [field]: url } });

    // Replacing a document leaves the old file orphaned in storage otherwise.
    // Best-effort, after the row is written: a storage hiccup must not undo a
    // document the panel has already been told was saved.
    const previous = (existing as Record<string, string | null>)[field];
    if (previous && previous !== url) void deleteStoredFile(previous);

    activityLogDocument(id, kind, "بارگذاری شد", req.user!.sub);
    return ok(res, { kind, url });
  })
);

router.delete(
  "/residences/:id/documents/:kind",
  requireDocumentKind,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const kind = req.params.kind as DocumentKind;
    const field = DOCUMENT_FIELDS[kind];
    if (!field) throw AppError.badRequest("نوع مدرک نامعتبر است");

    const existing = await prisma.residence.findUnique({
      where: { id },
      select: { [field]: true } as never,
    });
    if (!existing) throw AppError.notFound("اقامتگاه پیدا نشد");

    await prisma.residence.update({ where: { id }, data: { [field]: null } });

    const previous = (existing as Record<string, string | null>)[field];
    if (previous) void deleteStoredFile(previous);

    activityLogDocument(id, kind, "حذف شد", req.user!.sub);
    return ok(res, { kind, url: null });
  })
);

const DOCUMENT_LABEL: Record<DocumentKind, string> = {
  document: "سند/مدرک مالکیت",
  hostCard: "کارت ملی میزبان",
  ownerCard: "کارت ملی مالک",
};

function activityLogDocument(
  residenceId: number,
  kind: DocumentKind,
  what: string,
  actorId: number
) {
  activity.log({
    kind: "FIELD_CHANGE",
    residenceId,
    summary: `${DOCUMENT_LABEL[kind]} ${what}`,
    actorId,
    source: "ADMIN",
  });
}

export default router;
