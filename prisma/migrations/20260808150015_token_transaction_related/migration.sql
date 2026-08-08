-- AlterTable
ALTER TABLE "token_transactions" ADD COLUMN     "related_id" UUID,
ADD COLUMN     "related_type" TEXT;
