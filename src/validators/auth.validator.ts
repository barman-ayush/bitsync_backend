import { z } from "zod";

export const registerSchema = z.object({
    email: z
        .string({ message: "Email is required." })
        .refine((val) => val.split("@").length === 2 && val.split("@")[0] && val.split("@")[1], {
            message: "Please enter a valid email address.",
        }),
    password: z
        .string({ message: "Password is required." })
        .min(8, "Password must be at least 8 characters long.")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter.")
        .regex(/[a-z]/, "Password must contain at least one lowercase letter.")
        .regex(/[0-9]/, "Password must contain at least one number.")
        .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, "Password must contain at least one special character."),
    name: z
        .string({ message: "Name is required." })
        .min(1, "Name is required."),
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
