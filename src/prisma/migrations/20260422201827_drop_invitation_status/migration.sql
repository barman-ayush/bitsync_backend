/*
  Warnings:

  - You are about to drop the column `responded_at` on the `invitations` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `invitations` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[repo_id,invitee_email]` on the table `invitations` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "invitations_repo_id_invitee_email_status_key";

-- AlterTable
ALTER TABLE "invitations" DROP COLUMN "responded_at",
DROP COLUMN "status",
ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '7 days';

-- DropEnum
DROP TYPE "invitation_status";

-- CreateIndex
CREATE UNIQUE INDEX "invitations_repo_id_invitee_email_key" ON "invitations"("repo_id", "invitee_email");
