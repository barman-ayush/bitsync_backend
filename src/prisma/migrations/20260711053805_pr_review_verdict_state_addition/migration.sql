/*
  Warnings:

  - The values [COMMENTED] on the enum `review_verdict` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "review_verdict_new" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'PR_CLOSED');
ALTER TABLE "pr_reviews" ALTER COLUMN "verdict" TYPE "review_verdict_new" USING ("verdict"::text::"review_verdict_new");
ALTER TYPE "review_verdict" RENAME TO "review_verdict_old";
ALTER TYPE "review_verdict_new" RENAME TO "review_verdict";
DROP TYPE "public"."review_verdict_old";
COMMIT;
