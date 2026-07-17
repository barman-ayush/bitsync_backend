import { CookieOptions } from "express";

export const REFRESH_TOKEN_EXPIRY_DAYS = 7;
export const ACCESS_TOKEN_MAX_AGE_MS = 900 * 1000; // 15 minutes
export const REFRESH_TOKEN_MAX_AGE_MS = REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
export const CONCURRENT_REFRESH_GRACE_MS = 10 * 1000; // 10 seconds

export const SALT_ROUNDS = 10;

const isProduction = process.env.NODE_ENV === "production" || !process.env.CLIENT_URL?.includes("localhost");

export const AUTH_COOKIE_OPTIONS: CookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
};
