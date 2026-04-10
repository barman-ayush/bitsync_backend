export interface VerifyEmailPayload {
    email: string;
    purpose: "verify-email";
}

export interface AccessTokenPayload {
    sub: string;
    email: string;
    name: string;
}