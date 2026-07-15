import { z } from "zod";
import { ReviewVerdict, ConflictResolution } from "../generated/prisma/client";


export const prSchema = z.object({
    repoId: z.string().uuid(),
    workspaceId: z.string().uuid(),
});

export const createPullRequestSchema = z.object({
    title: z.string().min(1, "Title is required"),
    description: z.string().min(1, "Description is required"),
    reviewers: z.array(z.string().email()).optional(),
});

export const listPrQuerySchema = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
    q: z.string().optional(),
});

export const prDetailsSchema = z.object({
    prId: z.string().uuid(),
    repoId: z.string().uuid()
});

export const createCommentSchema = z.object({
    body: z.string().min(1, "Comment body is required"),
    filePath: z.string().optional(),
});

export const deleteCommentSchema = z.object({
    repoId: z.string().uuid(),
    prId: z.string().uuid(),
    commentId: z.string().uuid(),
});

export const resolveConflictsSchema = z.object({
    resolutions: z.array(z.object({
        conflictId: z.string().uuid("Invalid conflictId"),
        resolution: z.nativeEnum(ConflictResolution),
        resolvedBlob: z.string().nullable().optional()
    })).min(1, "At least one resolution is required")
});

export const prMergeabilitySchema = z.object({
    repoId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    prId: z.string().uuid()
});

export const listAssignedReviewsSchema = z.object({
    repoId: z.string().uuid()
});

export const listAssignedReviewsQuerySchema = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
    q: z.string().optional(),
    verdict: z.nativeEnum(ReviewVerdict).optional()
});

export const reviewerPrViewSchema = z.object({
    repoId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    prId: z.string().uuid()
});

export const addReviewersSchema = z.object({
    reviewerIds: z.array(z.string().uuid()).min(1, "At least one reviewer ID is required")
});

export const submitReviewSchema = z.object({
    verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
    body: z.string().optional()
});

export const prReviewStatusSchema = z.object({
    repoId: z.string().uuid(),
    prId: z.string().uuid()
});
