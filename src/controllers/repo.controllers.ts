import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { createRepoSchema, listRepoSchema, repoNameSchema, updateRepoSchema, userRepoRoleChangeSchema } from "../validators/repo.validator";
import mailService from "../services/mail.service";
import { repoInviteTemplate } from "../templates/repo-invite.template";
import { feUrls } from "../config/fe-urls";
import { Prisma } from "../generated/prisma/client";
import logger from "../services/logger.service";

export class RepoController {
    static async checkRepoNameAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsedName = repoNameSchema.safeParse(req.params.repoName);
            if (!parsedName.success) throw new BadRequestError(parsedName.error.issues[0].message);

            const nameNormalized = parsedName.data.toLowerCase();

            const existing = await db.prisma.repository.findFirst({
                where: { ownerId: req.user.sub, nameNormalized, isDeleted: false },
                select: { id: true },
            });

            res.status(200).json({
                status: "success",
                data: {
                    name: parsedName.data,
                    available: existing == null,
                },
            });
        } catch (err) {
            handleError("api/repo/check-name", err, next);
        }
    }

    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsed = listRepoSchema.safeParse(req.query);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { q, owner, role, created_from, created_to, has_commits, sort, direction, page, per_page } = parsed.data;

            const repoWhere: Prisma.RepositoryWhereInput = { isDeleted: false };

            if (q) {
                // q = User typed text search, can be anything.
                const qNorm = q.toLowerCase();
                repoWhere.OR = [
                    { nameNormalized: { contains: qNorm } },
                    { description: { contains: q, mode: "insensitive" } },
                    { owner: { usernameNormalized: { contains: qNorm } } },
                ];
            }

            if (owner) {
                const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner);
                if (isUuid) {
                    repoWhere.ownerId = owner;
                } else {
                    repoWhere.owner = { usernameNormalized: owner.toLowerCase() };
                }
            }

            if (created_from || created_to) {
                repoWhere.createdAt = {
                    ...(created_from ? { gte: created_from } : {}),
                    ...(created_to ? { lte: created_to } : {}),
                };
            }

            if (has_commits) {
                repoWhere.headCommit = has_commits === "true" ? { not: null } : null;
            }

            const memberWhere: Prisma.RepoMemberWhereInput = {
                userId: req.user.sub,
                deletedAt: null,
                repo: repoWhere,
            };
            if (role) memberWhere.role = role;

            const sortFieldMap = { created: "createdAt", updated: "updatedAt", name: "nameNormalized" } as const;
            const orderBy: Prisma.RepoMemberOrderByWithRelationInput = {
                repo: { [sortFieldMap[sort]]: direction },
            };

            const skip = (page - 1) * per_page;

            const [total_count, memberships] = await db.prisma.$transaction([
                db.prisma.repoMember.count({ where: memberWhere }),
                db.prisma.repoMember.findMany({
                    where: memberWhere,
                    orderBy,
                    skip,
                    take: per_page,
                    select: {
                        role: true,
                        repo: {
                            select: {
                                id: true,
                                name: true,
                                description: true,
                                ownerId: true,
                                headCommit: true,
                                createdAt: true,
                                updatedAt: true,
                                owner: { select: { username: true, usernameNormalized: true, avatarUrl: true } },
                            },
                        },
                    },
                }),
            ]);

            const items = memberships.map((m) => ({
                id: m.repo.id,
                name: m.repo.name,
                description: m.repo.description,
                ownerId: m.repo.ownerId,
                owner: {
                    username: m.repo.owner.username,
                    usernameNormalized: m.repo.owner.usernameNormalized,
                    avatarUrl: m.repo.owner.avatarUrl,
                },
                headCommit: m.repo.headCommit,
                createdAt: m.repo.createdAt,
                updatedAt: m.repo.updatedAt,
                role: m.role,
            }));

            res.status(200).json({
                status: "success",
                data: {
                    items,
                    page,
                    per_page,
                    total_count,
                    total_pages: total_count === 0 ? 0 : Math.ceil(total_count / per_page),
                },
            });
        } catch (err) {
            handleError("api/repo/list", err, next);
        }
    }

    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const parsed = createRepoSchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { name, description, users } = parsed.data;
            const nameNormalized = name.toLowerCase();
            const ownerId = req.user.sub;

            let repo;
            try {
                repo = await db.prisma.$transaction(async (tx) => {
                    const created = await tx.repository.create({
                        data: { name, nameNormalized, description, ownerId },
                    });
                    await tx.repoMember.create({
                        data: { repoId: created.id, userId: ownerId, role: "owner" },
                    });
                    // join users with specified roles.
                    if (users) await tx.repoMember.createMany({
                        data: users?.map((user) => ({
                            role: user.role,
                            repoId: created.id,
                            userId: user.userId
                        })),
                        skipDuplicates : true
                    });
                    return created;
                });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                    throw new ConflictError("You already have a repository with this name.");
                }
                throw err;
            }

            res.status(201).json({
                status: "success",
                message: "Repository created.",
                data: {
                    id: repo.id,
                    name: repo.name,
                    description: repo.description,
                    ownerId: repo.ownerId,
                    headCommit: repo.headCommit,
                    createdAt: repo.createdAt,
                    updatedAt: repo.updatedAt,
                    role: "owner",
                },
            });
        } catch (err) {
            handleError("api/repo/create", err, next);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { repoId } = req.params;

            const parsed = updateRepoSchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { name, description } = parsed.data;
            const nameNormalized = name.toLowerCase();

            let repo;
            try {
                repo = await db.prisma.repository.update({
                    where: { id: repoId as string },
                    data: { name, nameNormalized, description: description ?? null },
                });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                    throw new ConflictError("You already have a repository with this name.");
                }
                throw err;
            }

            res.status(200).json({
                status: "success",
                message: "Repository updated.",
                data: {
                    id: repo.id,
                    name: repo.name,
                    description: repo.description,
                    ownerId: repo.ownerId,
                    headCommit: repo.headCommit,
                    createdAt: repo.createdAt,
                    updatedAt: repo.updatedAt,
                    role: req.membership?.role,
                },
            });
        } catch (err) {
            handleError("[PUT]:api/repo/:id", err, next);
        }
    }

    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo!;

            res.status(200).json({
                status: "success",
                data: {
                    id: repo.id,
                    name: repo.name,
                    description: repo.description,
                    ownerId: repo.ownerId,
                    headCommit: repo.headCommit,
                    createdAt: repo.createdAt,
                    updatedAt: repo.updatedAt,
                    role: req.membership?.role,
                },
            });
        } catch (err) {
            handleError("[GET]:api/repo/:id", err, next);
        }
    }
    static async inviteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo!;
            const inviter = req.user!;

            const parsedData = userRepoRoleChangeSchema.safeParse(req.body);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { invitee_user_id, invitee_user_role } = parsedData.data;

            if (inviter.sub === invitee_user_id) throw new ForbiddenError("User cannot be self-invited");

            const invitee = await db.prisma.user.findUnique({ where: { id: invitee_user_id } });
            if (!invitee) throw new NotFoundError("User not found.");

            const existingMember = await db.prisma.repoMember.findFirst({
                where: { repoId: repo.id, userId: invitee_user_id, deletedAt: null },
                select: { id: true },
            });
            if (existingMember) throw new ConflictError("User is already a member of this repository.");

            const existing = await db.prisma.invitations.findFirst({
                where: { repoId: repo.id, inviteeId: invitee_user_id },
                orderBy: { createdAt: "desc" },
            });

            if (existing) {
                const isExpired = existing.expiresAt.getTime() < Date.now();
                if (!isExpired) {
                    throw new ConflictError("A pending invitation already exists for this user.");
                }
            }

            let invitation;
            try {
                invitation = await db.prisma.$transaction(async (tx) => {
                    const actor = await tx.repoMember.findFirst({
                        where: { repoId: repo.id, userId: inviter.sub, deletedAt: null },
                    });
                    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
                        throw new ForbiddenError("Insufficient permissions");
                    }
                    if (actor.role === "admin" && invitee_user_role !== "member") {
                        throw new ForbiddenError("Admins can only invite members.");
                    }

                    if (existing) {
                        await tx.invitations.deleteMany({ where: { id: existing.id } });
                    }
                    return tx.invitations.create({
                        data: {
                            repoId: repo.id,
                            inviterId: inviter.sub,
                            inviteeId: invitee_user_id,
                            inviteeEmail: invitee.email,
                            role: invitee_user_role,
                        },
                    });
                });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                    throw new ConflictError("A pending invitation already exists for this user.");
                }
                throw err;
            }

            const inviteLink = `${feUrls.home}/notifications`;
            try {
                await mailService.sendMail(
                    invitee.email,
                    `Invitation to join ${repo.name}`,
                    repoInviteTemplate(inviter.name, repo.name, invitee_user_role, inviteLink),
                );
            } catch (mailErr) {
                logger.warn(
                    "api/repo/user/invite",
                    `Failed to send invite email to ${invitee.email}: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}`,
                );
            }

            res.status(201).json({
                status: "success",
                message: "Invitation sent.",
                data: {
                    id: invitation.id,
                    repoId: invitation.repoId,
                    inviteeId: invitation.inviteeId,
                    inviteeEmail: invitation.inviteeEmail,
                    role: invitation.role,
                    expiresAt: invitation.expiresAt,
                    createdAt: invitation.createdAt,
                },
            });
        } catch (err) {
            handleError("api/repo/user/invite/:id", err, next);
        }
    }

    static async removeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo!;
            const inviterId = req.user!.sub;

            const parsedData = userRepoRoleChangeSchema.safeParse(req.body);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { invitee_user_id } = parsedData.data;

            if (invitee_user_id === inviterId) {
                throw new BadRequestError("Use leave repository instead.");
            }

            await db.prisma.$transaction(async (tx) => {
                const actor = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: inviterId, deletedAt: null },
                });
                if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
                    throw new ForbiddenError("Insufficient permissions");
                }

                const target = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: invitee_user_id, deletedAt: null },
                });
                if (!target) throw new NotFoundError("Member not found.");

                if (target.role === "owner") {
                    throw new ForbiddenError("Owner cannot be removed.");
                }

                if (actor.role === "admin" && target.role === "admin") {
                    throw new ForbiddenError("Admins can only remove members.");
                }

                await tx.repoMember.update({
                    where: { id: target.id },
                    data: { deletedAt: new Date() },
                });

                await tx.invitations.deleteMany({
                    where: {
                        repoId: repo.id,
                        OR: [{ inviteeId: invitee_user_id }, { inviterId: invitee_user_id }],
                    },
                });
            });

            res.status(200).json({
                status: "success",
                message: "Member removed.",
            });
        } catch (err) {
            handleError("/api/repo/user/remove/:id", err, next);
        }
    }

    static async promoteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo!;
            const inviterId = req.user!.sub;

            const parsedData = userRepoRoleChangeSchema.safeParse(req.body);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { invitee_user_id } = parsedData.data;

            if (invitee_user_id === inviterId) {
                throw new BadRequestError("Cannot change your own role.");
            }

            const { updated, alreadyAdmin } = await db.prisma.$transaction(async (tx) => {
                const actor = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: inviterId, deletedAt: null },
                });
                if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
                    throw new ForbiddenError("Insufficient permissions");
                }

                const target = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: invitee_user_id, deletedAt: null },
                });
                if (!target) throw new NotFoundError("Member not found.");

                if (target.role === "owner") {
                    throw new BadRequestError("Cannot promote owners.");
                }
                if (target.role === "admin") {
                    return { updated: target, alreadyAdmin: true };
                }

                const result = await tx.repoMember.update({
                    where: { id: target.id },
                    data: { role: "admin" },
                });
                return { updated: result, alreadyAdmin: false };
            });

            if (alreadyAdmin) {
                res.status(200).json({
                    status: "success",
                    message: "User already an admin.",
                });
                return;
            }

            res.status(200).json({
                status: "success",
                message: "Member promoted to admin.",
                data: { invitee_user_id: updated.userId, role: updated.role },
            });
        } catch (err) {
            handleError("/api/repo/user/promote/:id", err, next);
        }
    }

    static async demoteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo!;
            const inviterId = req.user!.sub;

            const parsedData = userRepoRoleChangeSchema.safeParse(req.body);
            if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

            const { invitee_user_id } = parsedData.data;

            if (invitee_user_id === inviterId) {
                throw new BadRequestError("Cannot change your own role.");
            }

            const updated = await db.prisma.$transaction(async (tx) => {
                const actor = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: inviterId, deletedAt: null },
                });
                if (!actor || actor.role !== "owner") {
                    throw new ForbiddenError("Only owners can demote admins.");
                }

                const target = await tx.repoMember.findFirst({
                    where: { repoId: repo.id, userId: invitee_user_id, deletedAt: null },
                });
                if (!target) throw new NotFoundError("Member not found.");

                if (target.role === "owner") {
                    throw new ForbiddenError("Owners cannot be demoted.");
                }

                if (target.role === "member") {
                    throw new BadRequestError("Members cannot be demoted any further.");
                }

                const result = await tx.repoMember.update({
                    where: { id: target.id },
                    data: { role: "member" },
                });

                await tx.invitations.updateMany({
                    where: {
                        repoId: repo.id,
                        inviteeId: invitee_user_id,
                        role: "admin",
                    },
                    data: { role: "member" },
                });

                await tx.invitations.deleteMany({
                    where: {
                        repoId: repo.id,
                        inviterId: invitee_user_id,
                    },
                });

                return result;
            });

            res.status(200).json({
                status: "success",
                message: "Admin demoted to member.",
                data: { invitee_user_id: updated.userId, role: updated.role },
            });
        } catch (err) {
            handleError("/api/repo/user/demote/:id", err, next);
        }
    }
}
