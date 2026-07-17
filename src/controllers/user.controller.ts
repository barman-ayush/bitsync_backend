import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { repositoryNonMemberUsersSchema, usernameSchema, updateUserProfileSchema } from "../validators/auth.validator";
import { User } from "../types/user.types";
import cloudinaryService from "../services/cloudinary.service";

export class UserDataController {
    static async fetchUserByUsername(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsedName = usernameSchema.safeParse(req.params.username);
            if (!parsedName.success) throw new BadRequestError(parsedName.error.issues[0].message);

            const nameNormalized = parsedName.data.toLowerCase();

            const users = await db.prisma.user.findMany({
                where: {
                    usernameNormalized: { contains: nameNormalized },
                    id: { not: req.user.sub },
                },
                select: { displayName: true, email: true, id: true },
                take: 20,
            });

            res.status(200).json({
                status: "success",
                data: users,
            });
        } catch (err) {
            handleError("/api/user/search/:username", err, next);
        }
    }

    public static async fetchRepositoryNonMemberUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsedData = repositoryNonMemberUsersSchema.safeParse(req.params);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { username, repoId } = parsedData.data;

            const nameNormalized = username.toLowerCase();


            // Caller must be an ACTIVE member — a removed (soft-deleted)
            // membership doesn't grant search access.
            const isAllowed = await db.prisma.repoMember.findFirst({
                where: {
                    repoId: repoId, userId: req.user.sub, deletedAt: null
                }
            })
            if (!isAllowed) throw new UnauthorizedError("You are not authorised to search for this repository.");

            const users = await db.prisma.user.findMany({
                where: {
                    usernameNormalized: {
                        contains: nameNormalized,
                    },

                    id: {
                        not: req.user.sub,
                    },

                    // Exclude only ACTIVE members. Users with a soft-deleted
                    // membership (removed/left) must stay searchable — they can
                    // be re-invited, and accepting revives their row.
                    repoMemberships: {
                        none: {
                            repoId: repoId,
                            deletedAt: null,
                        },
                    },
                },

                select: {
                    id: true,
                    displayName: true,
                    email: true,
                },

                take: 20,
            });

            res.status(200).json({
                status: "success",
                data: users,
            });
        } catch (err) {
            handleError("/api/user/search/repo/:username/:repoId", err, next);
        }
    }



    public static async getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const user: (User | null) = await db.prisma.user.findUnique({
                where: { id: req.user.sub },
                select: {
                    id: true,
                    email: true,
                    username: true,
                    displayName: true,
                    avatarUrl: true,
                    emailVerified: true,
                    createdAt: true,
                },
            });

            if (!user) throw new NotFoundError("User not found");

            res.status(200).json({
                status: "success",
                data: user,
            });
        } catch (err) {
            handleError("api/user/data", err, next);
        }
    }

    public static async checkUsernameAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const parsed = usernameSchema.safeParse(req.params.username);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const existing = await db.prisma.user.findUnique({
                where: { usernameNormalized: parsed.data.toLowerCase() },
                select: { id: true },
            });


            res.status(200).json({
                status: "success",
                data: { username: parsed.data, available: (existing == null) },
            });
        } catch (err) {
            handleError("api/user/check-username", err, next);
        }
    }

    public static async getUserProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsed = usernameSchema.safeParse(req.params.username);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const usernameNormalized = parsed.data.toLowerCase();

            const targetUser = await db.prisma.user.findUnique({
                where: { usernameNormalized },
                select: {
                    id: true,
                    email: true,
                    displayName: true,
                    avatarUrl: true,
                    username: true
                }
            });

            if (!targetUser) throw new NotFoundError("User not found");

            const userId = targetUser.id;
            let repositories = [];

            if (userId === req.user.sub) {
                // Fetch all repositories user is an active member of
                const memberships = await db.prisma.repoMember.findMany({
                    where: {
                        userId: userId,
                        deletedAt: null,
                        repo: {
                            isDeleted: false
                        }
                    },
                    include: {
                        repo: true
                    }
                });
                repositories = memberships.map(m => m.repo);
            } else {
                // Fetch all common repositories
                const commonMemberships = await db.prisma.repoMember.findMany({
                    where: {
                        userId: userId,
                        deletedAt: null,
                        repo: {
                            isDeleted: false,
                            members: {
                                some: {
                                    userId: req.user.sub,
                                    deletedAt: null
                                }
                            }
                        }
                    },
                    include: {
                        repo: true
                    }
                });
                repositories = commonMemberships.map(m => m.repo);
            }

            res.status(200).json({
                status: "success",
                data: {
                    user: targetUser,
                    repositories
                }
            });
        } catch (err) {
            handleError("/api/user/:username", err, next);
        }
    }

    public static async updateUserProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsed = updateUserProfileSchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { newDisplayName, avatarBlob } = parsed.data;

            const updateData: { displayName?: string; avatarUrl?: string } = {};

            if (newDisplayName !== undefined) {
                updateData.displayName = newDisplayName;
            }

            if (avatarBlob !== undefined) {
                let buffer: Buffer;
                // Check if it's a standard base64 Data URL (e.g. data:image/png;base64,...)
                if (avatarBlob.startsWith("data:")) {
                    const matches = avatarBlob.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                    if (!matches || matches.length !== 3) {
                        throw new BadRequestError("Invalid Data URL format for avatarBlob");
                    }
                    buffer = Buffer.from(matches[2], "base64");
                } else {
                    buffer = Buffer.from(avatarBlob, "base64");
                }

                // Upload to Cloudinary under the user's ID
                const avatarUrl = await cloudinaryService.uploadAvatar(buffer, req.user.sub);
                updateData.avatarUrl = avatarUrl;
            }

            const updatedUser = await db.prisma.user.update({
                where: { id: req.user.sub },
                data: updateData,
                select: {
                    id: true,
                    email: true,
                    displayName: true,
                    avatarUrl: true,
                    username: true,
                    emailVerified: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            res.status(200).json({
                status: "success",
                data: updatedUser
            });
        } catch (err) {
            handleError("/api/user/update", err, next);
        }
    }
}
