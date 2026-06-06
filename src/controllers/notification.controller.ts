import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { handleError } from "../middlewares/error.middleware";
import { NextFunction, Request, Response } from "express";
import db from "../services/database.service";
import { notificationIdParamSchema } from "../validators/notification.validator";


export class NotificationController {
    static async getByUserId(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const notifications = await db.prisma.notification.findMany({
                where: {
                    userId: req.user.sub,
                },
                include: {
                    actor: {
                        select: { email: true, displayName: true, avatarUrl: true },
                    },
                },
            });

            res.status(200).json({
                status: "success",
                data: {
                    notifications
                },
            });


        } catch (err) {
            handleError("/api/notification", err, next);
        }

    }

    // markAsRead - Marks one notification as read. updateMany scoped to the
    // caller's inbox does the ownership check and the update in one query —
    // count 0 means "not yours or doesn't exist", indistinguishable on purpose.
    static async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsed = notificationIdParamSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { count } = await db.prisma.notification.updateMany({
                where: { id: parsed.data.notificationId, userId: req.user.sub },
                data: { isRead: true },
            });
            if (count === 0) throw new NotFoundError("Notification not found.");

            res.status(200).json({
                status: "success",
                message: "Notification marked as read.",
            });
        } catch (err) {
            handleError("/api/notification/:notificationId/read", err, next);
        }
    }

    // markAllAsRead - Marks every unread notification in the caller's inbox as
    // read. Idempotent — an already-clean inbox is a success with count 0.
    static async markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const { count } = await db.prisma.notification.updateMany({
                where: { userId: req.user.sub, isRead: false },
                data: { isRead: true },
            });

            res.status(200).json({
                status: "success",
                message: "All notifications marked as read.",
                data: { updated: count },
            });
        } catch (err) {
            handleError("/api/notification/read-all", err, next);
        }
    }

}