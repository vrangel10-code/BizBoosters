-- CreateEnum
CREATE TYPE "RarityCode" AS ENUM ('C', 'U', 'R', 'L');

-- CreateTable
CREATE TABLE "cards" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "effect_text" TEXT,
    "description" TEXT,
    "rarity" "RarityCode" NOT NULL,
    "image_key" TEXT,
    "source_url" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_cards" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "copies_total" INTEGER NOT NULL,
    "copies_remaining" INTEGER NOT NULL,

    CONSTRAINT "room_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_rarities" (
    "room_id" UUID NOT NULL,
    "code" "RarityCode" NOT NULL,
    "label" TEXT NOT NULL,
    "color_hex" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "room_rarities_pkey" PRIMARY KEY ("room_id","code")
);

-- CreateIndex
CREATE INDEX "cards_school_id_rarity_idx" ON "cards"("school_id", "rarity");

-- CreateIndex
CREATE UNIQUE INDEX "cards_school_id_name_key" ON "cards"("school_id", "name");

-- CreateIndex
CREATE INDEX "room_cards_room_id_idx" ON "room_cards"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_cards_room_id_card_id_key" ON "room_cards"("room_id", "card_id");

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_cards" ADD CONSTRAINT "room_cards_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_cards" ADD CONSTRAINT "room_cards_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_rarities" ADD CONSTRAINT "room_rarities_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
