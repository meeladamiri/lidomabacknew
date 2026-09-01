import { prisma } from "@/lib/prisma";
import { publicResidenceId } from "@/lib/publicId";
import { forUser as announcementsForUser } from "@/modules/admin/announcements.service";

/**
 * پیشخوان — what a signed-in person sees first.
 *
 * The frontend has called `POST /api/users/dashboard` since the migration and
 * nothing has ever answered it, so the page rendered its empty state for every
 * user: no bookings, no profile prompts, no listings. Everything below already
 * existed in the database; none of it had a way out.
 *
 * ## It answers for guests too
 *
 * The page was built around hosts — incomplete listings, expert review, guest
 * reviews. A guest who has never hosted anything got a dashboard about
 * hosting. `is_host` now decides which halves are populated, and the sections
 * a guest cannot use simply come back empty so the page can drop them.
 *
 * ## "Current" means what a person would call current
 *
 * Not every booking: the ones that still need something, or that have not
 * happened yet. A stay from two years ago is history, and history belongs on
 * the trips page, not on the first screen.
 */

/** States where somebody is still waiting on somebody. */
const LIVE_STATES = ["HOST_APPROVAL", "SECOND_PAYMENT"] as const;

/** Live, plus confirmed stays that have not finished yet. */
function currentWhere(now: Date) {
  return {
    OR: [
      { state: { in: [...LIVE_STATES] } },
      { state: "DONE" as const, endDate: { gte: now } },
    ],
  };
}

const RESERVATION_CARD = {
  id: true,
  reference: true,
  state: true,
  startDate: true,
  endDate: true,
  daysCount: true,
  guestsCount: true,
  totalAmount: true,
  expiryDate: true,
  residence: {
    select: {
      id: true,
      name: true,
      reference: true,
      address: true,
      images: { take: 1, orderBy: { sortOrder: "asc" as const }, select: { url: true } },
    },
  },
} as const;

function toCard(r: {
  id: number;
  reference: string;
  state: string;
  startDate: Date;
  endDate: Date;
  daysCount: number;
  guestsCount: number;
  totalAmount: number | null;
  expiryDate: Date | null;
  residence: {
    id: number;
    name: string;
    reference: string | null;
    address: string | null;
    images: { url: string }[];
  } | null;
}) {
  return {
    id: r.id,
    reference: r.reference,
    state: r.state,
    start_date: r.startDate,
    end_date: r.endDate,
    days_count: r.daysCount,
    guests_count: r.guestsCount,
    total_amount: r.totalAmount ?? 0,
    expiry_date: r.expiryDate,
    product: r.residence && {
      // The public id, so a link from here reaches the listing page — the two
      // differ on every migrated residence.
      id: publicResidenceId(r.residence),
      name: r.residence.name,
      address: r.residence.address ?? "",
      image_url: r.residence.images[0]?.url ?? "",
    },
  };
}

export async function getDashboard(userId: number) {
  const now = new Date();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      avatarUrl: true,
      nationalCardUrl: true,
      isHost: true,
      verificationStatus: true,
      bankAccount: { select: { shabaNumber: true, cardNumber: true } },
    },
  });

  const [guestCurrent, hostCurrent, newResidences, waitingResidences, pendingReviews] =
    await Promise.all([
      prisma.reservation.findMany({
        where: { guestId: userId, ...currentWhere(now) },
        orderBy: { startDate: "asc" },
        take: 10,
        select: RESERVATION_CARD,
      }),

      // Only a host has these, and asking for them for everyone else is a
      // query per page load that can only ever return nothing.
      user.isHost
        ? prisma.reservation.findMany({
            where: { hostId: userId, ...currentWhere(now) },
            orderBy: { startDate: "asc" },
            take: 10,
            select: RESERVATION_CARD,
          })
        : Promise.resolve([]),

      user.isHost
        ? prisma.residence.findMany({
            where: { hostId: userId, state: "DRAFT" },
            orderBy: { updatedAt: "desc" },
            take: 6,
            select: {
              id: true,
              reference: true,
              name: true,
              completionPercent: true,
              step: true,
              updatedAt: true,
              images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
            },
          })
        : Promise.resolve([]),

      user.isHost
        ? prisma.residence.findMany({
            where: { hostId: userId, state: "PENDING" },
            orderBy: { updatedAt: "desc" },
            take: 6,
            select: {
              id: true,
              reference: true,
              name: true,
              updatedAt: true,
              images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
            },
          })
        : Promise.resolve([]),

      // Stays that finished and have no review yet — the one thing a guest can
      // usefully be nudged about.
      prisma.reservation.count({
        where: {
          guestId: userId,
          state: "DONE",
          endDate: { lt: now },
          review: null,
        },
      }),
    ]);

  const announcements = await announcementsForUser(user.isHost);

  /**
   * Numbers for the tile badges.
   *
   * Only counts that mean **somebody is waiting on you**. A badge showing how
   * many listings a host owns is decoration; a badge showing how many bookings
   * need their answer is a to-do list. Anything that does not shrink when the
   * work is done does not belong here.
   */
  const [liveReservations, unansweredReviews, unreadNotifications, unreadChats] =
    await Promise.all([
    // Confirmed, awaiting payment, or awaiting approval — the bookings that
    // are actually in play. DONE is bounded to stays that have not finished:
    // all-time DONE is a number that never goes down, and a badge that never
    // goes down is one the eye learns to skip.
    prisma.reservation.count({
      where: {
        ...(user.isHost ? { hostId: userId } : { guestId: userId }),
        OR: [
          { state: { in: ["HOST_APPROVAL", "SECOND_PAYMENT"] } },
          { state: "DONE", endDate: { gte: now } },
        ],
      },
    }),

    // Published guest reviews on this host's listings with no reply yet.
    user.isHost
      ? prisma.review.count({
          where: {
            residence: { hostId: userId },
            commentStatus: "PUBLISHED",
            hostAnswer: null,
          },
        })
      : Promise.resolve(0),

    prisma.notification.count({ where: { userId, readAt: null } }),

    // Kept as a running total on the participant row rather than counted over
    // messages — see ConversationParticipant.unreadCount.
    prisma.conversationParticipant
      .aggregate({
        where: { userId, leftAt: null },
        _sum: { unreadCount: true },
      })
      .then((a) => a._sum.unreadCount ?? 0),
  ]);

  return {
    partner: {
      id: user.id,
      name: user.name ?? "",
      image_url: user.avatarUrl ?? "",
      is_host: user.isHost,
      has_avatar: !!user.avatarUrl,
      has_national_card_image: !!user.nationalCardUrl,
      // A card number is not a شبا. The dashboard prompt says "شماره شبا",
      // so only that counts as having answered it.
      has_shaba: !!user.bankAccount?.shabaNumber,
      verification_status: user.verificationStatus,
    },

    guest_current_requests: guestCurrent.map(toCard),
    host_current_requests: hostCurrent.map(toCard),

    new_residences: newResidences.map((r) => ({
      id: publicResidenceId(r),
      name: r.name,
      completion_percent: r.completionPercent ?? 0,
      step: r.step ?? 1,
      last_update: r.updatedAt,
      image_url: r.images[0]?.url ?? "",
    })),

    residences_waiting_confirm: waitingResidences.map((r) => ({
      id: publicResidenceId(r),
      name: r.name,
      last_update: r.updatedAt,
      image_url: r.images[0]?.url ?? "",
    })),

    pending_reviews: pendingReviews,

    badges: {
      reservations: liveReservations,
      comments: unansweredReviews,
      residences: newResidences.length,
      notifications: unreadNotifications,
      chats: unreadChats,
      my_trips: guestCurrent.length,
    },
    announcements,
    // No chat unread count exists yet; reported as zero rather than omitted, so
    // the page's badge logic has something defined to read.
    pending_messages: 0,
    // The page's existing dialog reads a single `announcement`; it gets the
    // first modal-style one so it keeps working unchanged, while the banner
    // list is rendered separately.
    announcement: announcements.find((a) => a.style === "MODAL") ?? null,
  };
}
