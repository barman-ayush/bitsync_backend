import { Request, Response, NextFunction } from "express";
import tokenService from "../services/token.service";
import db from "../services/database.service";
import logger from "../services/logger.service";
import { ForbiddenError, UnauthorizedError } from "../errors/app.error";
import {
    ACCESS_TOKEN_MAX_AGE_MS,
    AUTH_COOKIE_OPTIONS,
    CONCURRENT_REFRESH_GRACE_MS,
    REFRESH_TOKEN_MAX_AGE_MS,
} from "../config/auth.config";
import { AccessTokenPayload } from "../types/jwt.types";

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
            throw new UnauthorizedError("Please login to continue");
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
                throw new UnauthorizedError("Invalid session, please login again");
            }
            // status === "expired" → fall through to refresh logic
        }

        // Refresh logic — needs a refresh token
        if (!refreshToken) {
            clearAuthCookies(res);
            throw new UnauthorizedError("Please login to continue");
        }

        const tokenHash = tokenService.hashRefreshToken(refreshToken);
        const stored = await db.prisma.refreshToken.findUnique({ where: { tokenHash } });

        if (!stored) {
            clearAuthCookies(res);
            throw new UnauthorizedError("Invalid session, please login again");
        }

        if (stored.revoked) {
            const revokedAgoMs = stored.revokedAt
                ? Date.now() - stored.revokedAt.getTime()
                : Number.POSITIVE_INFINITY;

            if (revokedAgoMs < CONCURRENT_REFRESH_GRACE_MS) {
                // Concurrent request — another request just rotated this token
                throw new UnauthorizedError("Please retry");
            }

            // Theft detected — revoke ALL tokens for this user
            await db.prisma.refreshToken.updateMany({
                where: { userId: stored.userId, revoked: false },
                data: { revoked: true, revokedAt: new Date() },
            });
            clearAuthCookies(res);
            logger.warn("[auth.middleware]", `Refresh token reuse detected for user ${stored.userId}`);
            throw new UnauthorizedError("Session compromised, all sessions revoked");
        }

        if (stored.expiresAt.getTime() <= Date.now()) {
            clearAuthCookies(res);
            throw new UnauthorizedError("Session expired, please login again");
        }

        // Valid refresh token — rotate
        const user = await db.prisma.user.findUnique({ where: { id: stored.userId } });
        if (!user) {
            clearAuthCookies(res);
            throw new UnauthorizedError("Invalid session, please login again");
        }

        if (!user.emailVerified) {
            clearAuthCookies(res);
            throw new ForbiddenError("Email not verified", "EMAIL_NOT_VERIFIED");
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
        next(err);
    }
}
