import { Request, Response, NextFunction } from "express";
import tokenService from "../services/token.service";
import db from "../services/database.service";
import logger from "../services/logger.service";
import { feUrls } from "../config/fe-urls";
import {
    ACCESS_TOKEN_MAX_AGE_MS,
    AUTH_COOKIE_OPTIONS,
    CONCURRENT_REFRESH_GRACE_MS,
    REFRESH_TOKEN_MAX_AGE_MS,
} from "../config/auth.config";
import { AccessTokenPayload } from "../types/jwt.types";

const TOAST = {
    notAuthenticated: `${feUrls.home}?toast="Please login to continue"`,
    sessionExpired: `${feUrls.home}?toast="Session expired, please login again"`,
    invalidSession: `${feUrls.home}?toast="Invalid session, please login again"`,
    pleaseRetry: `${feUrls.home}?toast="Please retry"`,
    compromised: `${feUrls.home}?toast="Session compromised, all sessions revoked"`,
};

function clearAuthCookies(res: Response): void {
    res.clearCookie("access_token", AUTH_COOKIE_OPTIONS);
    res.clearCookie("refresh_token", AUTH_COOKIE_OPTIONS);
}

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie("access_token", accessToken, { ...AUTH_COOKIE_OPTIONS, maxAge: ACCESS_TOKEN_MAX_AGE_MS });
    res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_MAX_AGE_MS });
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const accessToken: string | undefined = req.cookies?.access_token;
        const refreshToken: string | undefined = req.cookies?.refresh_token;

        // No tokens at all
        if (!accessToken && !refreshToken) {
            return res.redirect(TOAST.notAuthenticated);
        }

        // Try access token first
        if (accessToken) {
            const result = tokenService.verifyAccessToken(accessToken);

            if (result.status === "valid") {
                req.user = result.payload;
                return next();
            }

            if (result.status === "invalid") {
                clearAuthCookies(res);
                return res.redirect(TOAST.invalidSession);
            }
            // status === "expired" → fall through to refresh logic
        }

        // Refresh logic — needs a refresh token
        if (!refreshToken) {
            clearAuthCookies(res);
            return res.redirect(TOAST.notAuthenticated);
        }

        const tokenHash = tokenService.hashRefreshToken(refreshToken);
        const stored = await db.prisma.refreshToken.findUnique({ where: { tokenHash } });

        if (!stored) {
            clearAuthCookies(res);
            return res.redirect(TOAST.invalidSession);
        }

        if (stored.revoked) {
            const revokedAgoMs = stored.revokedAt
                ? Date.now() - stored.revokedAt.getTime()
                : Number.POSITIVE_INFINITY;

            if (revokedAgoMs < CONCURRENT_REFRESH_GRACE_MS) {
                // Concurrent request — another request just rotated this token
                return res.redirect(TOAST.pleaseRetry);
            }

            // Theft detected — revoke ALL tokens for this user
            await db.prisma.refreshToken.updateMany({
                where: { userId: stored.userId, revoked: false },
                data: { revoked: true, revokedAt: new Date() },
            });
            clearAuthCookies(res);
            logger.warn("[auth.middleware]", `Refresh token reuse detected for user ${stored.userId}`);
            return res.redirect(TOAST.compromised);
        }

        if (stored.expiresAt.getTime() <= Date.now()) {
            clearAuthCookies(res);
            return res.redirect(TOAST.sessionExpired);
        }

        // Valid refresh token — rotate
        const user = await db.prisma.user.findUnique({ where: { id: stored.userId } });
        if (!user) {
            clearAuthCookies(res);
            return res.redirect(TOAST.invalidSession);
        }

        const newAccessToken = tokenService.generateAccessToken(user);
        const { token: newRefreshToken, hash: newRefreshHash } = tokenService.generateRefreshToken();

        await db.prisma.$transaction([
            db.prisma.refreshToken.update({
                where: { id: stored.id },
                data: { revoked: true, revokedAt: new Date() },
            }),
            db.prisma.refreshToken.create({
                data: {
                    userId: user.id,
                    tokenHash: newRefreshHash,
                    deviceInfo: req.headers["user-agent"] || null,
                    expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
                },
            }),
        ]);

        setAuthCookies(res, newAccessToken, newRefreshToken);

        const payload: AccessTokenPayload = { sub: user.id, email: user.email, name: user.displayName };
        req.user = payload;
        return next();
    } catch (err) {
        logger.error("[auth.middleware]", err instanceof Error ? err.message : String(err));
        clearAuthCookies(res);
        return res.redirect(TOAST.invalidSession);
    }
}
