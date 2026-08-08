-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('owned', 'used', 'returned', 'revoked');

-- CreateEnum
CREATE TYPE "Acquisition" AS ENUM ('draw', 'trade', 'educator_grant');

-- CreateEnum
CREATE TYPE "DrawKind" AS ENUM ('token_draw', 'trade_upgrade');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "state" "ItemState" NOT NULL DEFAULT 'owned',
    "acquiredVia" "Acquisition" NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "student_note" TEXT,
    "draw_id" UUID,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draws" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "kind" "DrawKind" NOT NULL DEFAULT 'token_draw',
    "token_cost" INTEGER NOT NULL DEFAULT 0,
    "result_card_id" UUID NOT NULL,
    "result_rarity" "RarityCode" NOT NULL,
    "pool_snapshot" JSONB NOT NULL,
    "roll_value" INTEGER NOT NULL,
    "pool_size" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draws_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_items_enrollment_id_state_idx" ON "inventory_items"("enrollment_id", "state");

-- CreateIndex
CREATE INDEX "inventory_items_room_id_card_id_state_idx" ON "inventory_items"("room_id", "card_id", "state");

-- CreateIndex
CREATE INDEX "draws_room_id_created_at_idx" ON "draws"("room_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "draws_enrollment_id_idempotency_key_key" ON "draws"("enrollment_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_draw_id_fkey" FOREIGN KEY ("draw_id") REFERENCES "draws"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_result_card_id_fkey" FOREIGN KEY ("result_card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
