import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { handleError } from '../middlewares/error.middleware';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors/app.error';
import { loginSchema, registerSchema } from '../validators/auth.validator';
import db from '../services/database.service';
import tokenService from '../services/token.service';
import mailService from '../services/mail.service';
import { verifyEmailTemplate } from '../templates/verify-email.template';
import { VerifyEmailPayload } from '../types/jwt.types';
import { feUrls } from '../config/fe-urls';
import {
    ACCESS_TOKEN_MAX_AGE_MS,
    AUTH_COOKIE_OPTIONS,
    REFRESH_TOKEN_MAX_AGE_MS,
    SALT_ROUNDS,
} from '../config/auth.config';

export class AuthController {
    static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const parsed = registerSchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { email, password, name } = parsed.data;

            const getUser = await db.prisma.user.findUnique({
                where: { email }
            });

            if (getUser) throw new ConflictError("User with this email already exists.");

            const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

            const user = await db.prisma.user.create({
                data: {
                    email,
                    displayName: name,
                    passwordHash,
                },
            });

            const verifyToken = tokenService.generateVerifyEmailToken(email);
            const verifyLink = `${process.env.BACKEND_URL}/api/auth/verify-email?token=${verifyToken}`;
            await mailService.sendMail(email, "Verify your email", verifyEmailTemplate(name, verifyLink));

            res.status(200).json({
                status: "success",
                message: "User registered successfully. Please check your email to verify.",
                data: {
                    id: user.id,
                    email: user.email,
                    displayName: user.displayName,
                    avatarUrl: user.avatarUrl,
                    emailVerified: user.emailVerified,
                    createdAt: user.createdAt
                },
            });

        } catch (err) {
            handleError("api/auth/register", err, next);
        }
    }

    static async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { token } = req.query;

            if (!token || typeof token !== "string") throw new BadRequestError("Verification token is required.");

            const tokenPayload: VerifyEmailPayload | null = tokenService.verifyEmailToken(token);
            if (!tokenPayload) throw new UnauthorizedError("Invalid or expired verification link");

            const user = await db.prisma.user.findUnique({
                where: { email: tokenPayload.email }
            });

            if (!user) throw new NotFoundError("User not found");

            if (user.emailVerified) return res.redirect(`${feUrls.home}?toast="User already verified. If you are not authenticated, please try logging in."`);

            await db.prisma.user.update({
                where: { email: tokenPayload.email },
                data: { emailVerified: true }
            });

            const accessToken = tokenService.generateAccessToken(user);
            const { token: refreshToken, hash: refreshTokenHash } = tokenService.generateRefreshToken();

            await db.prisma.refreshToken.create({
                data: {
                    userId: user.id,
                    tokenHash: refreshTokenHash,
                    deviceInfo: req.headers["user-agent"] || null,
                    expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
                }
            });

            res.cookie("access_token", accessToken, { ...AUTH_COOKIE_OPTIONS, maxAge: ACCESS_TOKEN_MAX_AGE_MS });
            res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_MAX_AGE_MS });

            res.redirect(`${feUrls.home}?toast="Welcome to BitSync"`);

        } catch (err) {
            handleError("api/auth/verify-email", err, next);
        }
    }

    static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const parsed = loginSchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { email, password } = parsed.data;

            const user = await db.prisma.user.findUnique({ where: { email } });

            if (!user) throw new NotFoundError("No user with given email found.");

            if (!user.passwordHash) {
                throw new BadRequestError(
                    "This account uses OAuth. Login with Google/Microsoft or set a password in settings."
                );
            }

            if (!user.emailVerified) {
                const verifyToken = tokenService.generateVerifyEmailToken(user.email);
                const verifyLink = `${process.env.BACKEND_URL}/api/auth/verify-email?token=${verifyToken}`;
                await mailService.sendMail(user.email, "Verify your email", verifyEmailTemplate(user.displayName, verifyLink));

                throw new ForbiddenError("Email not verified. Verification email has been sent.", "EMAIL_NOT_VERIFIED");
            }

            const isValid = await bcrypt.compare(password, user.passwordHash);
            if (!isValid) throw new UnauthorizedError("Invalid email or password.");

            const accessToken = tokenService.generateAccessToken(user);
            const { token: refreshToken, hash: refreshTokenHash } = tokenService.generateRefreshToken();

            await db.prisma.refreshToken.create({
                data: {
                    userId: user.id,
                    tokenHash: refreshTokenHash,
                    deviceInfo: req.headers["user-agent"] || null,
                    expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
                },
            });

            res.cookie("access_token", accessToken, { ...AUTH_COOKIE_OPTIONS, maxAge: ACCESS_TOKEN_MAX_AGE_MS });
            res.cookie("refresh_token", refreshToken, { ...AUTH_COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_MAX_AGE_MS });

            res.status(200).json({
                status: "success",
                message: "Logged in successfully.",
                data: {
                    id: user.id,
                    email: user.email,
                    displayName: user.displayName,
                    avatarUrl: user.avatarUrl,
                    emailVerified: user.emailVerified,
                    createdAt: user.createdAt
                },
            });

        } catch (err) {
            handleError("api/auth/login", err, next);
        }
    }

    static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const refreshToken = req.cookies?.refresh_token;

            if (refreshToken) {
                const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

                await db.prisma.refreshToken.updateMany({
                    where: { tokenHash, revoked: false },
                    data: { revoked: true, revokedAt: new Date() },
                });
            }

            res.clearCookie("access_token", AUTH_COOKIE_OPTIONS);
            res.clearCookie("refresh_token", AUTH_COOKIE_OPTIONS);

            res.status(200).json({ status: "success", message: "Logged Out successfully !!" });
        } catch (err) {
            handleError("api/auth/logout", err, next);
        }
    }

    static async sendEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const user = await db.prisma.user.findUnique({ where: { id: req.user.sub } });
            if (!user) throw new NotFoundError("User not found");

            if (user.emailVerified) {
                res.status(200).json({ status: "success", message: "Email is already verified." });
                return;
            }

            const verifyToken = tokenService.generateVerifyEmailToken(user.email);
            const verifyLink = `${process.env.BACKEND_URL}/api/auth/verify-email?token=${verifyToken}`;
            await mailService.sendMail(user.email, "Verify your email", verifyEmailTemplate(user.displayName, verifyLink));

            res.status(200).json({ status: "success", message: "Verification email sent." });
        } catch (err) {
            handleError("api/auth/send-email", err, next);
        }
    }
}