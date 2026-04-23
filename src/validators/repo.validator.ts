import { z } from "zod";

export const createRepoSchema = z.object({
    name: z
        .string({ message: "Repository name is required." })
        .min(1, "Repository name is required.")
        .max(255, "Repository name must be at most 255 characters."),
    description: z
        .string()
        .max(10000, "Description is too long.")
        .optional(),
});

export const updateRepoSchema = z.object({
    name: z
        .string({ message: "Repository name is required." })
        .min(1, "Repository name is required.")
        .max(255, "Repository name must be at most 255 characters."),
    description: z
        .string()
        .max(10000, "Description is too long.")
        .nullable()
        .optional(),
});

export const userRepoRoleChangeSchema = z.object({
    invitee_user_id: z
        .string({ message: "user_id is required." })
        .uuid("user_id must be a valid UUID."),
    invitee_user_role: z
        .enum(["admin", "member"], { message: "user_role must be 'admin' or 'member'." })
});

export type CreateRepoInput = z.infer<typeof createRepoSchema>;
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;
export type UserRepoRoleChangeInput = z.infer<typeof userRepoRoleChangeSchema>;
