import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { usernameSchema } from "../validators/auth.validator";

export class UserDataController {
    public static async getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const user = await db.prisma.user.findUnique({
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
