-- CreateEnum
CREATE TYPE "entry_type" AS ENUM ('blob', 'tree');

-- CreateEnum
CREATE TYPE "workspace_status" AS ENUM ('CLEAN', 'MERGING', 'CONFLICTED');

-- CreateEnum
CREATE TYPE "change_action" AS ENUM ('ADD', 'MODIFY', 'DELETE');

-- CreateEnum
CREATE TYPE "pr_status" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "review_verdict" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED');

-- CreateEnum
CREATE TYPE "merge_status" AS ENUM ('IN_PROGRESS', 'RESOLVED', 'ABORTED');

-- CreateEnum
CREATE TYPE "conflict_type" AS ENUM ('EDIT_EDIT', 'DELETE_EDIT', 'ADD_ADD', 'DIR_FILE');

-- CreateEnum
CREATE TYPE "conflict_resolution" AS ENUM ('PENDING', 'TAKE_OURS', 'TAKE_THEIRS', 'MANUAL');

-- CreateTable
CREATE TABLE "blobs" (
    "blob_hash" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("blob_hash")
);

-- CreateTable
CREATE TABLE "trees" (
    "tree_hash" TEXT NOT NULL,

    CONSTRAINT "trees_pkey" PRIMARY KEY ("tree_hash")
);

-- CreateTable
CREATE TABLE "tree_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_tree" TEXT NOT NULL,
    "entry_type" "entry_type" NOT NULL,
    "name" TEXT NOT NULL,
    "object_hash" TEXT NOT NULL,

    CONSTRAINT "tree_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "commit_hash" TEXT NOT NULL,
    "root_tree" TEXT NOT NULL,
    "parent" TEXT,
    "author" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "message" TEXT NOT NULL,
    "parent_workspace_id" UUID,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("commit_hash")
);

-- CreateTable
CREATE TABLE "commit_parents" (
    "commit_hash" TEXT NOT NULL,
    "parent_hash" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "commit_parents_pkey" PRIMARY KEY ("commit_hash","ordinal")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repo_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "fork_point" TEXT,
    "head" TEXT,
    "status" "workspace_status" NOT NULL DEFAULT 'CLEAN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "file_path" TEXT NOT NULL,
    "action" "change_action" NOT NULL,
    "blob_hash" TEXT,

    CONSTRAINT "workspace_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repo_id" UUID NOT NULL,
    "workspace_id" UUID,
    "author_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "pr_status" NOT NULL DEFAULT 'OPEN',
    "pr_head" TEXT NOT NULL,
    "base_commit" TEXT,
    "merge_commit" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pr_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "verdict" "review_verdict" NOT NULL,
    "body" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pr_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "file_path" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pr_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "base_commit" TEXT NOT NULL,
    "ours_commit" TEXT NOT NULL,
    "theirs_commit" TEXT NOT NULL,
    "status" "merge_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "merged_tree" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_conflicts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merge_state_id" UUID NOT NULL,
    "file_path" TEXT NOT NULL,
    "conflict_type" "conflict_type" NOT NULL,
    "base_blob" TEXT,
    "ours_blob" TEXT,
    "theirs_blob" TEXT,
    "resolved_blob" TEXT,
    "resolution" "conflict_resolution" NOT NULL DEFAULT 'PENDING',
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "merge_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tree_entries_parent_tree_name_key" ON "tree_entries"("parent_tree", "name");

-- CreateIndex
CREATE INDEX "commits_parent_idx" ON "commits"("parent");

-- CreateIndex
CREATE INDEX "commits_parent_workspace_id_idx" ON "commits"("parent_workspace_id");

-- CreateIndex
CREATE INDEX "commit_parents_parent_hash_idx" ON "commit_parents"("parent_hash");

-- CreateIndex
CREATE INDEX "workspaces_repo_id_idx" ON "workspaces"("repo_id");

-- CreateIndex
CREATE INDEX "workspaces_user_id_idx" ON "workspaces"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_changes_workspace_id_file_path_key" ON "workspace_changes"("workspace_id", "file_path");

-- CreateIndex
CREATE INDEX "pull_requests_repo_id_status_idx" ON "pull_requests"("repo_id", "status");

-- CreateIndex
CREATE INDEX "pull_requests_workspace_id_idx" ON "pull_requests"("workspace_id");

-- CreateIndex
CREATE INDEX "pr_reviews_pr_id_idx" ON "pr_reviews"("pr_id");

-- CreateIndex
CREATE INDEX "pr_comments_pr_id_idx" ON "pr_comments"("pr_id");

-- CreateIndex
CREATE INDEX "merge_states_pr_id_idx" ON "merge_states"("pr_id");

-- CreateIndex
CREATE UNIQUE INDEX "merge_conflicts_merge_state_id_file_path_key" ON "merge_conflicts"("merge_state_id", "file_path");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_head_commit_fkey" FOREIGN KEY ("head_commit") REFERENCES "commits"("commit_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tree_entries" ADD CONSTRAINT "tree_entries_parent_tree_fkey" FOREIGN KEY ("parent_tree") REFERENCES "trees"("tree_hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_root_tree_fkey" FOREIGN KEY ("root_tree") REFERENCES "trees"("tree_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_parent_fkey" FOREIGN KEY ("parent") REFERENCES "commits"("commit_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_parent_workspace_id_fkey" FOREIGN KEY ("parent_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_parents" ADD CONSTRAINT "commit_parents_commit_hash_fkey" FOREIGN KEY ("commit_hash") REFERENCES "commits"("commit_hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_parents" ADD CONSTRAINT "commit_parents_parent_hash_fkey" FOREIGN KEY ("parent_hash") REFERENCES "commits"("commit_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_fork_point_fkey" FOREIGN KEY ("fork_point") REFERENCES "commits"("commit_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_head_fkey" FOREIGN KEY ("head") REFERENCES "commits"("commit_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_changes" ADD CONSTRAINT "workspace_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_changes" ADD CONSTRAINT "workspace_changes_blob_hash_fkey" FOREIGN KEY ("blob_hash") REFERENCES "blobs"("blob_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_pr_head_fkey" FOREIGN KEY ("pr_head") REFERENCES "commits"("commit_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_base_commit_fkey" FOREIGN KEY ("base_commit") REFERENCES "commits"("commit_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merge_commit_fkey" FOREIGN KEY ("merge_commit") REFERENCES "commits"("commit_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_base_commit_fkey" FOREIGN KEY ("base_commit") REFERENCES "commits"("commit_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_ours_commit_fkey" FOREIGN KEY ("ours_commit") REFERENCES "commits"("commit_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_theirs_commit_fkey" FOREIGN KEY ("theirs_commit") REFERENCES "commits"("commit_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_states" ADD CONSTRAINT "merge_states_merged_tree_fkey" FOREIGN KEY ("merged_tree") REFERENCES "trees"("tree_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_conflicts" ADD CONSTRAINT "merge_conflicts_merge_state_id_fkey" FOREIGN KEY ("merge_state_id") REFERENCES "merge_states"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_conflicts" ADD CONSTRAINT "merge_conflicts_base_blob_fkey" FOREIGN KEY ("base_blob") REFERENCES "blobs"("blob_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_conflicts" ADD CONSTRAINT "merge_conflicts_ours_blob_fkey" FOREIGN KEY ("ours_blob") REFERENCES "blobs"("blob_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_conflicts" ADD CONSTRAINT "merge_conflicts_theirs_blob_fkey" FOREIGN KEY ("theirs_blob") REFERENCES "blobs"("blob_hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_conflicts" ADD CONSTRAINT "merge_conflicts_resolved_blob_fkey" FOREIGN KEY ("resolved_blob") REFERENCES "blobs"("blob_hash") ON DELETE SET NULL ON UPDATE CASCADE;
