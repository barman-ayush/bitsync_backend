import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";

export class UserDataController {
    public static async getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const user = await db.prisma.user.findUnique({
                where: { id: req.user.sub },
                select: {
                    id: true,
                    email: true,
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
}
