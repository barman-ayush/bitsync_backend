import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { Prisma } from "../generated/prisma/client";

export class InvitationController {
    static async accept(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const { id } = req.params;
            const userId = req.user.sub;

            const invitation = await db.prisma.invitations.findUnique({ where: { id: id as string } });
            if (!invitation) throw new NotFoundError("Invitation not found.");
            if (invitation.expiresAt.getTime() < Date.now()) throw new BadRequestError("Invitation has expired.");

            const user = await db.prisma.user.findUnique({ where: { id: userId } });
            if (!user) throw new UnauthorizedError("User not found.");

            const idMatch = invitation.inviteeId === null || invitation.inviteeId === userId;
            const emailMatch = invitation.inviteeEmail === user.email;
            if (!idMatch || !emailMatch) {
                throw new ForbiddenError("This invitation is not for you.");
            }

            const existingMember = await db.prisma.repoMember.findFirst({
                where: { repoId: invitation.repoId, userId, deletedAt: null },
                select: { id: true },
            });
            if (existingMember) throw new ConflictError("You are already a member of this repository.");

            try {
                await db.prisma.$transaction(async (tx) => {
                    await tx.invitations.delete({ where: { id: id as string } });
                    await tx.repoMember.upsert({
                        where: { repoId_userId: { repoId: invitation.repoId, userId } },
                        create: {
                            repoId: invitation.repoId,
                            userId,
                            role: invitation.role,
                        },
                        update: {
                            role: invitation.role,
                            deletedAt: null,
                            joinedAt: new Date(),
                        },
                    });
                });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
                    throw new NotFoundError("Invitation not found.");
                }
                throw err;
            }

            res.status(200).json({
                status: "success",
                message: "Invitation accepted.",
                data: { repoId: invitation.repoId, role: invitation.role },
            });
        } catch (err) {
            handleError("api/invitation/:id/accept", err, next);
        }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const { id } = req.params;
            const userId = req.user.sub;

            const invitation = await db.prisma.invitations.findUnique({ where: { id: id as string } });
            if (!invitation) throw new NotFoundError("Invitation not found.");

            if (invitation.inviterId !== userId) {
                throw new ForbiddenError("Only the inviter can delete this invitation.");
            }

            try {
                await db.prisma.invitations.delete({ where: { id: id as string } });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
                    throw new NotFoundError("Invitation not found.");
                }
                throw err;
            }

            res.status(200).json({
                status: "success",
                message: "Invitation deleted.",
            });
        } catch (err) {
            handleError("api/invitation/:id/delete", err, next);
        }
    }

    static async reject(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const { id } = req.params;
            const userId = req.user.sub;

            const invitation = await db.prisma.invitations.findUnique({ where: { id: id as string } });
            if (!invitation) throw new NotFoundError("Invitation not found.");

            const user = await db.prisma.user.findUnique({ where: { id: userId } });
            if (!user) throw new UnauthorizedError("User not found.");

            const idMatch = invitation.inviteeId === null || invitation.inviteeId === userId;
            const emailMatch = invitation.inviteeEmail === user.email;
            if (!idMatch || !emailMatch) {
                throw new ForbiddenError("This invitation is not for you.");
            }

            try {
                await db.prisma.invitations.delete({ where: { id: id as string } });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
                    throw new NotFoundError("Invitation not found.");
                }
                throw err;
            }

            res.status(200).json({
                status: "success",
                message: "Invitation declined.",
            });
        } catch (err) {
            handleError("api/invitation/:id/reject", err, next);
        }
    }
}
