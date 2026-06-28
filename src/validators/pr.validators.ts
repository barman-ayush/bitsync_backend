import { z } from "zod";

export const prSchema = z.object({
    repoId: z.string().uuid(),
    workspaceId: z.string().uuid(),
});

export const createPullRequestSchema = z.object({
    title: z.string().min(1, "Title is required"),
    description: z.string().min(1, "Description is required"),
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
