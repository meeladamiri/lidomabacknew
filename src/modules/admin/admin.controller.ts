import { Request, Response } from "express";
import { ok, created, paginated } from "@/utils/response";
import { AppError } from "@/lib/errors";
import { fileToUrl } from "@/middleware/upload";
import * as service from "./admin.service";
import * as expiryService from "@/modules/reservations/expiry.service";
import * as cancellationService from "@/modules/reservations/cancellation.service";
import * as stateService from "@/modules/reservations/stateChange.service";
import type { ReservationState } from "@prisma/client";

/**
 * A number out of a query string — which may already be a number.
 *
 * `validate()` replaces `req.query` with the *parsed* object, and the list
 * schema declares `page`, `pageSize` and `residenceId` as `z.coerce.number()`.
 * So by the time a controller reads them they are numbers, and rejecting
 * anything that is not a string silently dropped every one of them: the
 * residence filter was ignored and paging always fell back to page 1.
 */
function getOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value;
}

export async function dashboardStats(_req: Request, res: Response) {
  const data = await service.getDashboardStats();

  return ok(res, data);
}

export async function listUsers(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const result = await service.listUsers({
    page: getOptionalNumber(q.page),
    pageSize: getOptionalNumber(q.pageSize),
    q: getOptionalString(q.q),
    tab: q.tab as service.UserRoleTab | undefined,
    isActive: typeof q.isActive === "boolean" ? q.isActive : undefined,
    verificationStatus: q.verificationStatus as
      | "NOT_CONFIRMED"
      | "CHECKING"
      | "CONFIRMED"
      | undefined,
    sort: q.sort as "newest" | "oldest" | "reservations" | "name" | undefined,
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function userTabCounts(_req: Request, res: Response) {
  return ok(res, await service.userTabCounts());
}

export async function createUser(req: Request, res: Response) {
  return ok(res, await service.createUser(req.body), 201);
}

export async function setUserPassword(req: Request, res: Response) {
  return ok(res, await service.setUserPassword(Number(req.params.id), req.body.password));
}

export async function addYellowCard(req: Request, res: Response) {
  const card = await service.addYellowCard(Number(req.params.id), req.body.reason, req.user?.sub);
  return ok(res, card, 201);
}

export async function removeYellowCard(req: Request, res: Response) {
  return ok(res, await service.removeYellowCard(Number(req.params.id)));
}

export async function dashboardOverview(_req: Request, res: Response) {
  return ok(res, await service.getDashboardOverview());
}

export async function getUser(req: Request, res: Response) {
  const data = await service.getUser(Number(req.params.id));

  return ok(res, data);
}

export async function updateUser(req: Request, res: Response) {
  const data = await service.updateUser(Number(req.params.id), req.body);

  return ok(res, data);
}

function getFilters(value: unknown): service.FilterCondition[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function residenceFilterFields(_req: Request, res: Response) {
  return ok(res, service.RESIDENCE_FILTER_FIELDS);
}

export async function listResidences(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const result = await service.listResidences({
    page: getOptionalNumber(q.page),
    pageSize: getOptionalNumber(q.pageSize),
    q: getOptionalString(q.q),
    state: getOptionalString(q.state),
    tab: q.tab as service.ResidenceTab | undefined,
    sort: q.sort as
      | "newest"
      | "oldest"
      | "price_asc"
      | "price_desc"
      | "importance"
      | "rating"
      | undefined,
    filters: getFilters(q.filters),
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function residenceTabCounts(_req: Request, res: Response) {
  return ok(res, await service.residenceTabCounts());
}

export async function bulkResidenceState(req: Request, res: Response) {
  return ok(
    res,
    await service.bulkUpdateResidenceState(req.body.ids, req.body.state, {
      note: req.body.note,
      actorId: req.user?.sub ?? null,
    })
  );
}

export async function bulkResidenceType(req: Request, res: Response) {
  return ok(res, await service.bulkUpdateResidenceType(req.body.ids, req.body.type));
}

export async function bulkDeleteResidences(req: Request, res: Response) {
  return ok(res, await service.bulkDeleteResidences(req.body.ids));
}

export async function bulkCopyResidences(req: Request, res: Response) {
  return ok(res, await service.bulkCopyResidences(req.body.ids));
}

export async function exportResidences(req: Request, res: Response) {
  const csv = await service.exportResidencesCsv(req.body.ids);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="residences.csv"');
  return res.send(csv);
}

export async function getResidence(req: Request, res: Response) {
  const data = await service.getResidence(Number(req.params.id));

  return ok(res, data);
}

export async function setResidenceDistances(req: Request, res: Response) {
  return ok(res, await service.setResidenceDistances(Number(req.params.id), req.body.distances));
}

export async function setResidenceExtraCities(req: Request, res: Response) {
  return ok(res, await service.setResidenceExtraCities(Number(req.params.id), req.body.cityIds));
}

export async function setResidenceState(req: Request, res: Response) {
  const data = await service.setResidenceState(Number(req.params.id), req.body.state, {
    note: req.body.note,
    actorId: req.user?.sub ?? null,
  });

  return ok(res, data);
}

export async function updateResidenceSpecs(req: Request, res: Response) {
  const data = await service.adminUpdateResidenceSpecs(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceAmenities(req: Request, res: Response) {
  const data = await service.adminUpdateAmenities(
    Number(req.params.id),
    req.body.amenities,
    req.body.other,
    req.body.scopeIds
  );
  return ok(res, data);
}

export async function updateResidenceRules(req: Request, res: Response) {
  const data = await service.adminUpdateRules(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidencePricing(req: Request, res: Response) {
  const data = await service.adminUpdatePricing(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceCapacity(req: Request, res: Response) {
  const data = await service.adminUpdateCapacity(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function addResidenceRoom(req: Request, res: Response) {
  const data = await service.adminAddRoom(Number(req.params.id), req.body);
  return created(res, data);
}

export async function replaceResidenceRooms(req: Request, res: Response) {
  const data = await service.adminReplaceRooms(Number(req.params.id), req.body);
  return ok(res, data);
}

export async function updateResidenceRoom(req: Request, res: Response) {
  const data = await service.adminUpdateRoom(Number(req.params.roomId), req.body);
  return ok(res, data);
}

export async function deleteResidenceRoom(req: Request, res: Response) {
  await service.adminDeleteRoom(Number(req.params.roomId));
  return ok(res, { success: true });
}

export async function uploadResidenceImage(req: Request, res: Response) {
  if (!req.file) throw AppError.badRequest("فایل تصویر ارسال نشده است");
  const url = fileToUrl(req.file);
  const isMain = req.body.isMain === undefined ? undefined : req.body.isMain === "true";
  const data = await service.adminAddImage(Number(req.params.id), url, req.body.title, isMain);
  return created(res, data);
}

export async function updateResidenceImage(req: Request, res: Response) {
  const data = await service.adminUpdateImage(
    Number(req.params.id),
    Number(req.params.imageId),
    req.body as { title?: string | null; alt?: string | null; isMain?: boolean }
  );
  return ok(res, data);
}

export async function deleteResidenceImage(req: Request, res: Response) {
  await service.adminDeleteImage(Number(req.params.id), Number(req.params.imageId));
  return ok(res, { success: true });
}

export async function reorderResidenceImages(req: Request, res: Response) {
  await service.adminReorderImages(Number(req.params.id), req.body.imageIds);
  return ok(res, { success: true });
}

export async function listReservations(req: Request, res: Response) {
  const result = await service.listReservations({
    page: getOptionalNumber(req.query.page),
    pageSize: getOptionalNumber(req.query.pageSize),
    state: getOptionalString(req.query.state),
    q: getOptionalString(req.query.q),
    residenceId: getOptionalNumber(req.query.residenceId),
  });

  return paginated(res, result.items, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  });
}

export async function getReservation(req: Request, res: Response) {
  const data = await service.getReservation(Number(req.params.id));

  return ok(res, data);
}

export async function listFilterPresets(req: Request, res: Response) {
  const data = await service.listFilterPresets(getOptionalString(req.query.entity));
  return ok(res, data);
}

export async function createFilterPreset(req: Request, res: Response) {
  const data = await service.createFilterPreset(req.body.name, req.body.entity, req.body.filters);
  return ok(res, data);
}

export async function deleteFilterPreset(req: Request, res: Response) {
  await service.deleteFilterPreset(Number(req.params.id));
  return ok(res, { success: true });
}

export async function updateReservation(req: Request, res: Response) {
  const data = await service.updateReservationByAdmin(
    Number(req.params.id),
    req.body.action,
    req.body.reason,
    req.body.desc
  );

  return ok(res, data);
}

/**
 * Moves one booking's deadline.
 *
 * Odoo allowed the same edit on the sale order, and support needs it for the
 * case it was built for: a host who has just called to say they are on their
 * way should not lose the booking to a clock.
 */
export async function setReservationExpiry(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  const { expiryDate, minutesFromNow } = req.body as {
    expiryDate?: Date | null;
    minutesFromNow?: number;
  };

  return ok(res, await expiryService.setExpiry(id, { expiryDate, minutesFromNow }));
}

/**
 * Cancelling from the panel.
 *
 * Support gets the levers a guest and a host do not: marking a cancellation
 * justified, waiving the refund entirely, overriding the penalty for the
 * long-stay and peak bands the policy settles "by agreement", and choosing who
 * hears about it.
 */
export async function adminCancelReservation(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };

  const result = await cancellationService.cancelReservation({
    reservationId: id,
    ...(req.body as Omit<
      Parameters<typeof cancellationService.cancelReservation>[0],
      "reservationId" | "actorId"
    >),
    actorId: req.user?.sub ?? null,
  });

  return ok(res, result);
}

/** The money a cancellation would cost, before anyone commits to it. */
export async function cancelQuote(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  const q = req.query as Record<string, unknown>;

  return ok(
    res,
    await cancellationService.quoteFor(id, {
      cancelledBy:
        (q.cancelledBy as "HOST_CANCELLED" | "GUEST_CANCELLED" | "LIDOMA_CANCELLED") ??
        "LIDOMA_CANCELLED",
      justified: q.justified === true || q.justified === "true",
      withoutPayback: q.withoutPayback === true || q.withoutPayback === "true",
      penaltyOverride: q.penaltyOverride != null ? Number(q.penaltyOverride) : null,
    })
  );
}

/** Moves a booking between states by hand, with the reason attached. */
export async function changeReservationState(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  const { toState, note, notify } = req.body as {
    toState: ReservationState;
    note: string;
    notify?: boolean;
  };

  return ok(
    res,
    await stateService.changeState({
      reservationId: id,
      toState,
      note,
      notify,
      actorId: req.user!.sub,
    })
  );
}

/** The booking's state history, and where it may go from here. */
export async function reservationStateHistory(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: number };
  const reservation = await service.getReservation(id);

  return ok(res, {
    current: reservation.state,
    current_label: stateService.STATE_LABELS[reservation.state],
    allowed: stateService.allowedTransitions(reservation.state).map((s) => ({
      state: s,
      label: stateService.STATE_LABELS[s],
    })),
    history: await stateService.history(id),
  });
}
