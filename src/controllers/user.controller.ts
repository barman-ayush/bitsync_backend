import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { repositoryNonMemberUsersSchema, usernameSchema } from "../validators/auth.validator";
import { User } from "../types/user.types";

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

            const parsedData = repositoryNonMemberUsersSchema.safeParse(req.params.username);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { username, repoId } = parsedData.data;

            const nameNormalized = username.toLowerCase();


            const isAllowed = await db.prisma.repoMember.findFirst({
                where: {
                    repoId: repoId, userId: req.user.sub
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

                    repoMemberships: {
                        none: {
                            repoId: repoId,
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
}
