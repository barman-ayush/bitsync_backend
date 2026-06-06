import { z } from "zod";

export const repositoryId = z.object({
    repoId: z.string().uuid()
});

export const repoContextSchema = z.object({
    reponame: z.string(),
    username: z.string(),
})
export const repoNameSchema = z
    .string({ message: "Repository name is required." })
    .min(1, "Repository name is required.")
    .max(255, "Repository name must be at most 255 characters.")
    .regex(/^[a-zA-Z0-9-]+$/, "Repository name can only contain letters, numbers, and hyphens.")
    .refine((val) => !val.startsWith("-"), { message: "Repository name cannot start with a hyphen." })
    .refine((val) => !val.endsWith("-"), { message: "Repository name cannot end with a hyphen." })
    .refine((val) => !val.includes("--"), { message: "Repository name cannot contain consecutive hyphens." });

// One invitee entry — shared by repo creation and the invite endpoint.
const inviteUserEntry = z.object({
    email: z
        .string({ message: "user_email is required." })
        .email("user_email must be a valid email address."),
    role: z.enum(["member", "admin"]),
});

export const createRepoSchema = z.object({
    name: repoNameSchema,
    description: z
        .string()
        .max(10000, "Description is too long.")
        .optional(),

    users: z
        .array(inviteUserEntry)
        .max(50, "Cannot invite more than 50 users at once.")
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

export const inviteUsers = z.array(inviteUserEntry)
    .min(1, "At least one user is required.")
    .max(50, "Cannot invite more than 50 users at once.")

// Accept/decline an invite — the notification id IS the invite id. repoId and
// role are read server-side from the notification's data snapshot, never from
// the client (a client-sent role would allow privilege escalation).
export const invitationBodySchema = z.object({
    notificationId: z.string().uuid(),
})

// Target of a member-management action (remove/promote/demote). The repo comes
// from the :repoId path param (validated by requireRepoAccess) — the body only
// names WHO is being acted on.
export const memberTargetSchema = z.object({
    userId : z.string().uuid()
})

export type CreateRepoInput = z.infer<typeof createRepoSchema>;
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;
export type UserRepoRoleChangeInput = z.infer<typeof userRepoRoleChangeSchema>;
export type ListRepoInput = z.infer<typeof listRepoSchema>;
export type InviteUsersInput = z.infer<typeof inviteUsers>;
