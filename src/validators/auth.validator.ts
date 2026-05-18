import { z } from "zod";

const RESERVED_USERNAMES = new Set([
    "admin", "administrator", "root", "api", "auth", "login", "logout",
    "signup", "register", "user", "users", "settings", "help", "support",
    "about", "contact", "terms", "privacy", "billing", "search", "explore",
    "notifications", "home", "dashboard", "bitsync",
]);

export const usernameSchema = z
    .string({ message: "Username is required." })
    .min(1, "Username is required.")
    .max(39, "Username must be at most 39 characters.")
    .regex(/^[a-zA-Z0-9-]+$/, "Username can only contain letters, numbers, and hyphens.")
    .refine((val) => !val.startsWith("-"), { message: "Username cannot start with a hyphen." })
    .refine((val) => !val.endsWith("-"), { message: "Username cannot end with a hyphen." })
    .refine((val) => !val.includes("--"), { message: "Username cannot contain consecutive hyphens." })
    .refine((val) => !RESERVED_USERNAMES.has(val.toLowerCase()), { message: "This username is reserved." });

export const registerSchema = z.object({
    email: z
        .string({ message: "Email is required." })
        .refine((val) => val.split("@").length === 2 && val.split("@")[0] && val.split("@")[1], {
            message: "Please enter a valid email address.",
        }),
    username: usernameSchema,
    password: z
        .string({ message: "Password is required." })
        .min(8, "Password must be at least 8 characters long.")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter.")
        .regex(/[a-z]/, "Password must contain at least one lowercase letter.")
        .regex(/[0-9]/, "Password must contain at least one number.")
        .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, "Password must contain at least one special character.")
});

export const loginSchema = z.object({
    email: z
        .string({ message: "Email is required." })
        .refine((val) => val.split("@").length === 2 && val.split("@")[0] && val.split("@")[1], {
            message: "Please enter a valid email address.",
        }),
    password: z
        .string({ message: "Password is required." })
        .min(1, "Password is required."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
