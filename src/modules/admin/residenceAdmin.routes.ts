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
import * as reviews from "./reviews.service";
import { sendReviewApprovedMessage } from "./reviewMessages";
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
    return ok(res, await reviews.listForResidence(id, { includeHidden: true }));
  })
);

const reviewIdParam = z.object({ reviewId: z.coerce.number().int().positive() });
const MODERATION = z.enum(["PENDING", "PUBLISHED", "REJECTED"]);

/** The panel's «نظرات» list, across every listing. */
router.get(
  "/reviews",
  validate(
    z.object({
      query: z.object({
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(50).optional(),
        q: z.string().optional(),
        tab: z.enum(["all", "pending", "published", "rejected", "low"]).optional(),
        residenceId: z.coerce.number().int().positive().optional(),
        hostId: z.coerce.number().int().positive().optional(),
        sort: z.enum(["action", "newest", "oldest", "rating_asc", "rating_desc"]).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const result = await reviews.list(req.query as never);
    // The panel's standard pager reads `meta`, so this goes out in the same
    // envelope as every other list rather than a shape only this page knows.
    //
    // `sortedBy` rides along because the service can decline the requested
    // order: above its cap, "action" order falls back to newest-first, and a
    // page that silently shows a different order than the one it offers is
    // worse than one that says so.
    return res.status(200).json({
      status: "success",
      data: result.items,
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        pageCount: Math.max(1, Math.ceil(result.total / result.pageSize)),
        sortedBy: result.sortedBy,
      },
    });
  })
);

router.get("/reviews/tab-counts", asyncHandler(async (_req, res) => ok(res, await reviews.tabCounts())));

router.get(
  "/reviews/:reviewId",
  validate(z.object({ params: reviewIdParam })),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await reviews.getOne(reviewId));
  })
);

/** Approve or reject the guest's comment. A rejection must say why. */
router.post(
  "/reviews/:reviewId/comment-status",
  validate(
    z.object({
      params: reviewIdParam,
      body: z.object({ status: MODERATION, note: z.string().trim().max(500).optional() }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(
      res,
      await reviews.setCommentStatus(reviewId, req.body.status, {
        note: req.body.note,
        actorId: req.user!.sub,
      })
    );
  })
);

/** Approve or reject the host's reply. */
router.post(
  "/reviews/:reviewId/answer-status",
  validate(
    z.object({
      params: reviewIdParam,
      body: z.object({ status: MODERATION, note: z.string().trim().max(500).optional() }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(
      res,
      await reviews.setHostAnswerStatus(reviewId, req.body.status, {
        note: req.body.note,
        actorId: req.user!.sub,
      })
    );
  })
);

router.put(
  "/reviews/:reviewId/comment",
  validate(
    z.object({
      params: reviewIdParam,
      body: z.object({ comment: z.string().trim().min(1).max(4000) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await reviews.editComment(reviewId, req.body.comment, req.user!.sub));
  })
);

/**
 * The six scores. Every field optional — the panel sends only what moved.
 *
 * Integers 1..5, matching what the guest's own form can produce: a review the
 * panel edited must stay a review a guest could have written.
 */
const SCORE = z.coerce.number().int().min(1).max(5).optional();

router.put(
  "/reviews/:reviewId/scores",
  validate(
    z.object({
      params: reviewIdParam,
      body: z
        .object({
          cleaning: SCORE,
          location: SCORE,
          quality: SCORE,
          integrity: SCORE,
          greeting: SCORE,
          delivery: SCORE,
        })
        .refine((b) => Object.values(b).some((v) => v !== undefined), {
          message: "هیچ امتیازی برای تغییر فرستاده نشده",
        }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await reviews.editScores(reviewId, req.body, req.user!.sub));
  })
);

router.put(
  "/reviews/:reviewId/answer",
  validate(
    z.object({
      params: reviewIdParam,
      body: z.object({ answer: z.string().trim().min(1).max(2000) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await reviews.editHostAnswer(reviewId, req.body.answer, req.user!.sub));
  })
);

/**
 * «به مهمان بگو نظرت تأییده» / «به میزبان بگو نظرت تأییده».
 *
 * Refuses if the thing it would announce is not actually published — telling
 * someone their text is live when it is not is worse than not telling them.
 */
router.post(
  "/reviews/:reviewId/notify",
  validate(
    z.object({
      params: reviewIdParam,
      body: z.object({ audience: z.enum(["guest", "host"]) }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { reviewId } = req.params as unknown as { reviewId: number };
    return ok(res, await sendReviewApprovedMessage(reviewId, req.body.audience, req.user!.sub));
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
