import { z } from "zod";

export const repoNameSchema = z
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

    users: z
        .array(
            z.object({
                userId: z
                    .string({ message: "user_id is required." })
                    .uuid("user_id must be a valid UUID."),
                role: z.enum(["member", "admin"]),
            })
        )
        .optional(),
});

export const updateRepoSchema = z.object({
    name: repoNameSchema,
    description: z
        .string()
        .max(10000, "Description is too long.")
        .nullable()
        .optional(),
    users: z
        .array(
            z.object({
                userId: z
                    .string({ message: "user_id is required." })
                    .uuid("user_id must be a valid UUID."),
                role: z.enum(["member", "admin"]),
            })
        )
        .optional(),
});

export const userRepoRoleChangeSchema = z.object({
    invitee_user_id: z
        .string({ message: "user_id is required." })
        .uuid("user_id must be a valid UUID."),
    invitee_user_role: z
        .enum(["admin", "member"], { message: "user_role must be 'admin' or 'member'." })
});

export const listRepoSchema = z
    .object({
        q: z.string().trim().min(1).max(255).optional(),
        owner: z.string().trim().min(1).max(255).optional(),
        role: z.enum(["owner", "admin", "member"]).optional(),
        created_from: z.coerce.date({ message: "created_from must be a valid date." }).optional(),
        created_to: z.coerce.date({ message: "created_to must be a valid date." }).optional(),
        has_commits: z.enum(["true", "false"]).optional(),
        sort: z.enum(["created", "updated", "name"]).default("updated"),
        direction: z.enum(["asc", "desc"]).default("desc"),
        page: z.coerce.number().int().min(1).default(1),
        per_page: z.coerce.number().int().min(1).max(100).default(30),
    })
    .refine(
        (d) => !(d.created_from && d.created_to) || d.created_from <= d.created_to,
        { message: "created_from must be before or equal to created_to.", path: ["created_from"] },
    );

export type CreateRepoInput = z.infer<typeof createRepoSchema>;
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;
export type UserRepoRoleChangeInput = z.infer<typeof userRepoRoleChangeSchema>;
export type ListRepoInput = z.infer<typeof listRepoSchema>;
