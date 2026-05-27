export type User = {
    id: string;
    createdAt: Date;
    email: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
}