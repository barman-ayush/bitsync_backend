import jwt, { TokenExpiredError } from "jsonwebtoken";
import crypto from "crypto";
import logger from "./logger.service";
import { AccessTokenPayload, VerifyEmailPayload } from "../types/jwt.types";

const JWT_SECRET = process.env.JWT_SECRET!;

export type AccessTokenVerifyResult =
    | { status: "valid"; payload: AccessTokenPayload }
    | { status: "expired" }
    | { status: "invalid" };


class TokenService {
    private static instance: TokenService;

    private constructor() {}

    public static getInstance(): TokenService {
        if (!this.instance) {
            this.instance = new TokenService();
        }
        return this.instance;
    }

    public generateVerifyEmailToken(email: string): string {
        const payload: VerifyEmailPayload = { email, purpose: "verify-email" };
        const expiresIn = Number(process.env.JWT_VERIFY_EXPIRY) || 86400; // seconds, default 24h
        return jwt.sign(payload, JWT_SECRET, { expiresIn });
    }

    public verifyEmailToken(token: string): VerifyEmailPayload | null {
        try {
            const payload  = jwt.verify(token, JWT_SECRET) as VerifyEmailPayload;
            if (payload.purpose !== "verify-email") return null;
            return payload;
        } catch (err) {
            logger.error("TOKEN", `Invalid or expired token: ${err}`);
            return null;
        }
    }

    public generateAccessToken(user: { id: string; email: string; displayName: string }): string {
        const payload: AccessTokenPayload = { sub: user.id, email: user.email, name: user.displayName };
        const expiresIn = Number(process.env.JWT_ACCESS_EXPIRY) || 900; // 15 minutes
        return jwt.sign(payload, JWT_SECRET, { expiresIn });
    }

    public generateRefreshToken(): { token: string; hash: string } {
        const token = crypto.randomBytes(64).toString("hex");
        const hash = crypto.createHash("sha256").update(token).digest("hex");
        return { token, hash };
    }

    public verifyAccessToken(token: string): AccessTokenVerifyResult {
        try {
            const payload = jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
            if (!payload.sub || !payload.email) return { status: "invalid" };
            return { status: "valid", payload };
        } catch (err) {
            if (err instanceof TokenExpiredError) return { status: "expired" };
            logger.error("TOKEN", `Invalid access token: ${err}`);
            return { status: "invalid" };
        }
    }

    public hashRefreshToken(token: string): string {
        return crypto.createHash("sha256").update(token).digest("hex");
    }
}

const tokenService = TokenService.getInstance();

export default tokenService;
