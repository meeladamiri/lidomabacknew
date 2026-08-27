-- Conversations: host <-> guest threads hung off a reservation, and user <->
-- support threads. Replaces the Odoo endpoints the front still calls
-- (/api/get_order_messages, /api/get_messages, /api/add_message,
-- /api/support_chats/*), all of which are dead.
--
-- Three denormalisations are deliberate and each pays for itself:
--   conversations.last_message_at/_preview  -> the list is one query, not N+1
--   conversation_participants.unread_count  -> the header badge is one sum
--   conversations.residence_id              -> admin filtering without a join
--                                              through reservations

CREATE TYPE "ConversationType" AS ENUM ('BOOKING', 'SUPPORT');

CREATE TYPE "ConversationStatus" AS ENUM (
  'OPEN',
  'PENDING', -- support: answered, waiting on the user
  'CLOSED'
);

CREATE TYPE "ParticipantRole" AS ENUM ('GUEST', 'HOST', 'ADMIN');

CREATE TYPE "MessageType" AS ENUM (
  'TEXT',
  'IMAGE',
  'FILE',
  'SYSTEM',        -- reservation created / state changed; rendered as a card
  'INTERNAL_NOTE'  -- admin-only, never leaves the panel
);

CREATE TABLE "conversations" (
  "id"                   SERIAL NOT NULL,
  -- URLs carry this, not the primary key.
  "public_id"            TEXT NOT NULL,
  "type"                 "ConversationType" NOT NULL,
  "status"               "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "subject"              TEXT,
  "booking_id"           INTEGER,
  "residence_id"         INTEGER,
  "assigned_admin_id"    INTEGER,
  "last_message_at"      TIMESTAMP(3),
  "last_message_preview" TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversations_public_id_key" ON "conversations"("public_id");

-- The whole of the "one thread per reservation" guarantee. The service asks
-- for a conversation and handles the unique violation as "someone else just
-- made it" — a read-then-write check would let two simultaneous callers both
-- pass the read.
CREATE UNIQUE INDEX "conversations_booking_id_key" ON "conversations"("booking_id");

CREATE INDEX "conversations_type_status_last_message_at_idx"
  ON "conversations"("type", "status", "last_message_at");
CREATE INDEX "conversations_residence_id_idx" ON "conversations"("residence_id");

CREATE TABLE "conversation_participants" (
  "id"                   SERIAL NOT NULL,
  "conversation_id"      INTEGER NOT NULL,
  "user_id"              INTEGER NOT NULL,
  "role"                 "ParticipantRole" NOT NULL,
  "unread_count"         INTEGER NOT NULL DEFAULT 0,
  "last_read_at"         TIMESTAMP(3),
  "last_read_message_id" INTEGER,
  "notified_at"          TIMESTAMP(3),
  "is_muted"             BOOLEAN NOT NULL DEFAULT false,
  "left_at"              TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_participants_conversation_id_user_id_key"
  ON "conversation_participants"("conversation_id", "user_id");
CREATE INDEX "conversation_participants_user_id_idx"
  ON "conversation_participants"("user_id");

CREATE TABLE "messages" (
  "id"              SERIAL NOT NULL,
  "conversation_id" INTEGER NOT NULL,
  "sender_id"       INTEGER,
  "sender_role"     "ParticipantRole",
  "type"            "MessageType" NOT NULL DEFAULT 'TEXT',
  "body"            TEXT NOT NULL,
  "meta"            JSONB,
  "attachment_url"  TEXT,
  "attachment_name" TEXT,
  "attachment_size" INTEGER,
  -- Makes a retried optimistic send a no-op instead of a duplicate.
  "client_nonce"    TEXT,
  "flagged"         BOOLEAN NOT NULL DEFAULT false,
  "deleted_at"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "messages_conversation_id_client_nonce_key"
  ON "messages"("conversation_id", "client_nonce");

-- Paging a thread walks id descending within one conversation.
CREATE INDEX "messages_conversation_id_id_idx" ON "messages"("conversation_id", "id");

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "reservations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_residence_id_fkey"
  FOREIGN KEY ("residence_id") REFERENCES "residences"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_assigned_admin_id_fkey"
  FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Deleting a conversation takes its participants and messages with it; there
-- is nothing meaningful left of either without the thread.
ALTER TABLE "conversation_participants"
  ADD CONSTRAINT "conversation_participants_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_participants"
  ADD CONSTRAINT "conversation_participants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted account must not take the other side's history with it: the
-- message stays, the authorship goes.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
