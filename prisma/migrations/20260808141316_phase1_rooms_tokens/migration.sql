-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "RoomEducatorRole" AS ENUM ('owner', 'assistant');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "TokenReason" AS ENUM ('educator_award', 'educator_adjustment', 'draw_spend', 'draw_refund', 'system_correction');

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'active',
    "draw_cost_tokens" INTEGER NOT NULL DEFAULT 20,
    "trades_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trade_ratio" INTEGER NOT NULL DEFAULT 3,
    "students_see_odds" BOOLEAN NOT NULL DEFAULT true,
    "low_stock_threshold" INTEGER NOT NULL DEFAULT 20,
    "low_stock_alerted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_educators" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "RoomEducatorRole" NOT NULL DEFAULT 'assistant',

    CONSTRAINT "room_educators_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "token_balance" INTEGER NOT NULL DEFAULT 0,
    "seat_label" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_transactions" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "reason" "TokenReason" NOT NULL,
    "note" TEXT,
    "actor_user_id" UUID,
    "reverses_id" UUID,
    "batch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "subject_enrollment_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rooms_school_id_status_idx" ON "rooms"("school_id", "status");

-- CreateIndex
CREATE INDEX "room_educators_user_id_idx" ON "room_educators"("user_id");

-- CreateIndex
CREATE INDEX "enrollments_student_id_status_idx" ON "enrollments"("student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_room_id_student_id_key" ON "enrollments"("room_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_transactions_reverses_id_key" ON "token_transactions"("reverses_id");

-- CreateIndex
CREATE INDEX "token_transactions_enrollment_id_created_at_idx" ON "token_transactions"("enrollment_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_room_id_created_at_idx" ON "activity_events"("room_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_subject_enrollment_id_created_at_idx" ON "activity_events"("subject_enrollment_id", "created_at");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_educators" ADD CONSTRAINT "room_educators_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_educators" ADD CONSTRAINT "room_educators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "token_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_subject_enrollment_id_fkey" FOREIGN KEY ("subject_enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
