import { z } from "zod";

const repoNameSchema = z
    .string({ message: "Repository name is required." })
    .min(1, "Repository name is required.")
    .max(255, "Repository name must be at most 255 characters.")
    .regex(/^[a-zA-Z0-9-]+$/, "Repository name can only contain letters, numbers, and hyphens.")
    .refine((val) => !val.startsWith("-"), { message: "Repository name cannot start with a hyphen." })
    .refine((val) => !val.endsWith("-"), { message: "Repository name cannot end with a hyphen." })
    .refine((val) => !val.includes("--"), { message: "Repository name cannot contain consecutive hyphens." });

export const createRepoSchema = z.object({
    name: repoNameSchema,
    description: z
        .string()
        .max(10000, "Description is too long.")
        .optional(),
});

export const updateRepoSchema = z.object({
    name: repoNameSchema,
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
