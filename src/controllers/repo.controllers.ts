import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, ConflictError, ForbiddenError, InternalError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { createRepoSchema, invitationBodySchema, inviteUsers, listRepoSchema, memberTargetSchema, repoNameSchema, repositoryId, repositoryTreeContext, updateRepoSchema, userRepoRoleChangeSchema } from "../validators/repo.validator";
import { Prisma } from "../generated/prisma/client";
import notificationService from "../services/notification.service";
import { InviteByEmailResult, RepoInviteData } from "../types/notification.types";
import logger from "../services/logger.service";

export class RepoController {
    // inviteSummary - Shapes an invite batch result for API responses (counts
    // for the buckets, raw emails for what the caller needs to act on).
    private static inviteSummary(result: InviteByEmailResult) {
        return {
            invited: result.created.length,
            updated: result.updated.length,
            skipped: result.skipped.length,
            notFound: result.notFound,
            alreadyMember: result.alreadyMember,
        };
    }

    // checkRepoNameAvailability : Checks whether a given username under a given username is available or not.
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

    // searchRepository : Queries Repository using keywords/filters.
    static async searchRepository(req: Request, res: Response, next: NextFunction): Promise<void> {
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
            handleError("api/repo/", err, next);
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
                    return created;
                });
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                    throw new ConflictError("You already have a repository with this name.");
                }
                throw err;
            }

            // Invitees go through the same repo_invite notification flow as the
            // invite endpoint — they only become members once they accept. The
            // repo is already committed, so an invite failure must not 500 the
            // creation; it is reported as invites: null instead.
            let invites = null;
            if (users && users.length > 0) {
                try {
                    const result = await notificationService.inviteByEmail({
                        actorId: ownerId,
                        actorName: req.user.name,
                        repoId: repo.id,
                        repoName: repo.name,
                        users,
                    });
                    invites = RepoController.inviteSummary(result);
                } catch (err) {
                    logger.error("api/repo/create", `Failed to send invites for repo ${repo.id}: ${err}`);
                }
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
                    invites,
                },
            });
        } catch (err) {
            handleError("api/repo/create", err, next);
        }
    }
    // showRepo - Page-mount response. Returns the full repo metadata resolved by
    // resolveRepoBySlug, including the repo id and the caller's role. The FE holds
    // the id and uses it for all subsequent tab/data calls (/:repoId/...).
    static async showRepo(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const repo = req.repo;
            if (!repo) throw new NotFoundError("Repository not found");

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
        } catch (e) {
            handleError("api/repo/:username/:reponame", e, next);
        }
    }

    // fetchContributors - Contributors tab. Keyed off req.repoId (set by
    // requireRepoAccess); single RepoMember read, no join.
    static async fetchContributors(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const contributors = await db.prisma.repoMember.findMany({
                where: { repoId: req.repoId, deletedAt: null },
                select: {
                    role: true,
                    joinedAt: true,
                    user: {
                        select: {
                            id: true,
                            displayName: true,
                            username: true,
                            email: true,
                            avatarUrl: true,
                        }
                    }
                }
            });

            res.status(200).json({
                status: "success",
                data: contributors
            });
        } catch (e) {
            handleError("api/repo/:repoId/contributors", e, next);
        }
    }
    // inviteContributors - Invites a batch of existing users (by email) to the
    // repo as member/admin. Access (owner/admin) is enforced by middleware via
    // requireRepoAccess + authorize("member:invite"). Each invite becomes a
    // repo_invite notification; the create/update/skip decision lives in the
    // notification service. Emails with no account or users who are already
    // active members are reported back without failing the request.
    static async inviteContributors(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Not authenticated");

            const repoId = req.repoId;
            if (!repoId) throw new BadRequestError("Repository id is required.");


            const parsed = inviteUsers.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            // Repo name is snapshotted into the notification; access was already
            // verified by the middleware.
            const repo = await db.prisma.repository.findFirst({
                where: { id: repoId, isDeleted: false },
                select: { name: true },
            });
            if (!repo) throw new NotFoundError("Repository not found");

            const result = await notificationService.inviteByEmail({
                actorId: req.user.sub,
                actorName: req.user.name,
                repoId,
                repoName: repo.name,
                users: parsed.data,
            });

            res.status(200).json({
                status: "success",
                message: "Invitations processed.",
                data: RepoController.inviteSummary(result),
            });
        } catch (e) {
            handleError("api/repo/:repoId/invite", e, next);
        }
    }

    // acceptInvite - Accepts a repo_invite notification (the notification IS the
    // invite — its data snapshot carries repoId/role). The invite is consumed
    // (hard-deleted) on every outcome; what varies is the message:
    //   - expired              -> delete, 400 "invitation expired"
    //   - repo gone            -> delete, 404 "repository no longer exists"
    //   - already a member     -> delete, 200 (no membership change)
    //   - otherwise            -> create/revive membership + delete, atomically
    static async acceptInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = invitationBodySchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { notificationId } = parsed.data;
            const userId = req.user.sub;

            // Must be this user's own repo_invite — scoping by userId also
            // prevents accepting someone else's invite by guessing ids.
            const invite = await db.prisma.notification.findFirst({
                where: { id: notificationId, userId, type: "repo_invite" },
            });
            if (!invite) throw new NotFoundError("Invitation not found.");

            const { repoId, repoName, role } = invite.data as RepoInviteData;

            // Expired — consume the invite and tell the user to ask for a new one.
            if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
                await db.prisma.notification.delete({ where: { id: invite.id } });
                throw new BadRequestError("This invitation has expired. Ask for a new invite.");
            }

            // data is a snapshot (no FK) — the repo may have been deleted since.
            const repo = await db.prisma.repository.findFirst({
                where: { id: repoId, isDeleted: false },
                select: { id: true },
            });
            if (!repo) {
                await db.prisma.notification.delete({ where: { id: invite.id } });
                throw new NotFoundError(`${repoName} no longer exists.`);
            }

            // Existing membership row, active or soft-deleted (unique on repoId+userId).
            const membership = await db.prisma.repoMember.findUnique({
                where: { repoId_userId: { repoId, userId } },
            });

            // Already in the repo (any role) — consume the invite, change nothing.
            if (membership && membership.deletedAt === null) {
                await db.prisma.notification.delete({ where: { id: invite.id } });
                res.status(200).json({
                    status: "success",
                    message: `You are already a member of ${repoName}.`,
                });
                return;
            }

            // Join (or rejoin if previously removed) and consume the invite atomically.
            await db.prisma.$transaction([
                membership
                    ? db.prisma.repoMember.update({
                        where: { id: membership.id },
                        data: { role, deletedAt: null, joinedAt: new Date() },
                    })
                    : db.prisma.repoMember.create({ data: { repoId, userId, role } }),
                db.prisma.notification.delete({ where: { id: invite.id } }),
            ]);

            // Tell the inviter (spec 03 §2). actorId can be null if the
            // inviter's account was deleted — nobody to notify then.
            if (invite.actorId) {
                await notificationService.notify({
                    userId: invite.actorId,
                    actorId: userId,
                    type: "invite_accepted",
                    context: { actorName: req.user.name, repoName },
                    data: { repoId, repoName },
                });
            }

            res.status(200).json({
                status: "success",
                message: `You joined ${repoName} as ${role}.`,
            });

        } catch (err) {
            handleError("/api/repo/invite/accept", err, next);
        }
    }

    // declineInvite - Declines a repo_invite notification. Declining consumes
    // the invite the same way accepting does, but nothing else changes — so the
    // expiry/repo-exists checks from acceptInvite are pointless here: whatever
    // their answer, the outcome is identical (delete the invite). Find it,
    // delete it, done.
    static async declineInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = invitationBodySchema.safeParse(req.body);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { notificationId } = parsed.data;
            const userId = req.user.sub;

            // Must be this user's own repo_invite — scoping by userId also
            // prevents declining someone else's invite by guessing ids.
            const invite = await db.prisma.notification.findFirst({
                where: { id: notificationId, userId, type: "repo_invite" },
            });
            if (!invite) throw new NotFoundError("Invitation not found.");

            const { repoId, repoName } = invite.data as RepoInviteData;

            await db.prisma.notification.delete({ where: { id: invite.id } });

            // Tell the inviter (spec 03 §2). actorId can be null if the
            // inviter's account was deleted — nobody to notify then.
            if (invite.actorId) {
                await notificationService.notify({
                    userId: invite.actorId,
                    actorId: userId,
                    type: "invite_declined",
                    context: { actorName: req.user.name, repoName },
                    data: { repoId, repoName },
                });
            }

            res.status(200).json({
                status: "success",
                message: `Invitation to ${repoName} declined.`,
            });

        } catch (err) {
            handleError("/api/repo/invite/decline", err, next);
        }
    }

    // resolveMemberTarget - Shared lookup for remove/promote/demote: validates
    // the body, loads the target's ACTIVE membership (soft-deleted rows are
    // "not a member") and the repo name for the outgoing notification.
    private static async resolveMemberTarget(req: Request) {
        const repoId = req.repoId;
        if (!repoId) throw new BadRequestError("Repository id is required.");

        const parsed = memberTargetSchema.safeParse(req.body);
        if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);
        const { userId } = parsed.data;

        const [membership, repo] = await Promise.all([
            db.prisma.repoMember.findUnique({
                where: { repoId_userId: { repoId, userId }, deletedAt: null },
            }),
            db.prisma.repository.findUnique({ where: { id: repoId }, select: { name: true } }),
        ]);

        if (!repo) throw new NotFoundError("Repository not found");
        if (!membership) throw new NotFoundError("User is not a member of this repository.");

        return { repoId, userId, membership, repoName: repo.name };
    }

    // leaveRepository - Caller removes themselves from the repo. Active
    // membership is already verified by requireRepoAccess; the owner cannot
    // leave (the repo would be orphaned) — transfer or delete instead.
    static async leaveRepository(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const repoId = req.repoId;
            if (!repoId) throw new BadRequestError("Repository id is required.");

            if (req.membership?.role === "owner") {
                throw new ForbiddenError("Owner cannot leave the repository. Transfer ownership or delete it instead.");
            }

            await db.prisma.repoMember.update({
                where: { repoId_userId: { repoId, userId: req.user.sub } },
                data: { deletedAt: new Date() },
            });

            res.status(200).json({
                status: "success",
                message: "You left the repository.",
            });
        } catch (err) {
            handleError("/api/repo/:repoId/leave", err, next);
        }
    }

    // removeUser - Soft-deletes the target's membership. Caller's owner/admin
    // role is enforced by authorize("member:remove"); on top of that:
    //   - the owner can never be removed
    //   - an admin can only remove members — removing an admin takes the owner
    //   - self-removal is rejected (that's what /leave is for)
    static async removeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const { repoId, userId, membership, repoName } = await RepoController.resolveMemberTarget(req);

            if (req.user.sub === userId) {
                throw new BadRequestError("You cannot remove yourself — leave the repository instead.");
            }
            if (membership.role === "owner") {
                throw new ForbiddenError("The owner cannot be removed.");
            }
            if (membership.role === "admin" && req.membership?.role !== "owner") {
                throw new ForbiddenError("Only the owner can remove an admin.");
            }

            await db.prisma.repoMember.update({
                where: { id: membership.id },
                data: { deletedAt: new Date() },
            });

            await notificationService.notify({
                userId,
                actorId: req.user.sub,
                type: "member_removed",
                context: { actorName: req.user.name, repoName },
                data: { repoId, repoName },
            });

            res.status(200).json({
                status: "success",
                message: "User removed from the repository.",
            });
        } catch (err) {
            handleError("/api/repo/:repoId/remove", err, next);
        }
    }

    // promoteUser - member -> admin. Caller's owner/admin role is enforced by
    // authorize("member:promote"); the owner's role is immutable and an admin
    // target is reported as a conflict, not silently ignored.
    static async promoteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const { repoId, userId, membership, repoName } = await RepoController.resolveMemberTarget(req);

            if (membership.role === "owner") throw new BadRequestError("The owner's role cannot be changed.");
            if (membership.role === "admin") throw new ConflictError("User is already an admin.");

            await db.prisma.repoMember.update({
                where: { id: membership.id },
                data: { role: "admin" },
            });

            await notificationService.notify({
                userId,
                actorId: req.user.sub,
                type: "role_changed",
                context: { actorName: req.user.name, repoName, oldRole: "member", newRole: "admin" },
                data: { repoId, repoName, oldRole: "member", newRole: "admin" },
            });

            res.status(200).json({
                status: "success",
                message: "User promoted to admin.",
            });
        } catch (err) {
            handleError("/api/repo/:repoId/promote", err, next);
        }
    }

    // demoteUser - admin -> member. Owner-only via authorize("member:demote");
    // the owner's role is immutable and a member target is a conflict.
    static async demoteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const { repoId, userId, membership, repoName } = await RepoController.resolveMemberTarget(req);

            if (membership.role === "owner") throw new BadRequestError("The owner's role cannot be changed.");
            if (membership.role === "member") throw new ConflictError("User is already a member.");

            await db.prisma.repoMember.update({
                where: { id: membership.id },
                data: { role: "member" },
            });

            await notificationService.notify({
                userId,
                actorId: req.user.sub,
                type: "role_changed",
                context: { actorName: req.user.name, repoName, oldRole: "admin", newRole: "member" },
                data: { repoId, repoName, oldRole: "admin", newRole: "member" },
            });

            res.status(200).json({
                status: "success",
                message: "User demoted to member.",
            });
        } catch (err) {
            handleError("/api/repo/:repoId/demote", err, next);
        }
    }

    // This fetches the whole repository data (current main line code).
    static async fetchRepositoryData(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsedRepoId = repositoryId.safeParse(req.params);
            if (!parsedRepoId.success) throw new BadRequestError("Invalid repository id.");

            const parsedQuery = repositoryTreeContext.safeParse(req.query);
            if (!parsedQuery.success) throw new BadRequestError("Invalid query.");

            const { repoId } = parsedRepoId.data;
            const { treeHash } = parsedQuery.data;

            const repository = await db.prisma.repository.findUnique({ where: { id: repoId, isDeleted: false } });
            if (!repository) throw new NotFoundError("Repository not found.");
            if (!repository.headCommit) {
                res.status(200).json({
                    status: "success",
                    message: "Empty repository.",
                    data: {
                        tree: [],
                    }
                });
                return;
            }

            let currentLevelObjectHash: string;

            if (treeHash) {
                const treeExists = await db.prisma.tree.findUnique({ where: { treeHash } });
                if (!treeExists) throw new NotFoundError("Directory not found.");
                currentLevelObjectHash = treeHash;
            } else {
                const commit = await db.prisma.commit.findUnique({ where: { commitHash: repository.headCommit } });
                if (!commit) throw new InternalError("Repository head commit not found.");
                currentLevelObjectHash = commit.rootTree;
            }

            const entries = await db.prisma.treeEntry.findMany({
                where: { parentTree: currentLevelObjectHash },
                orderBy: [
                    { entryType: "desc" },
                    { name: "asc" }
                ]
            });

            const blobHashes = [
                ...new Set(entries.filter((e) => e.entryType === "blob").map((e) => e.objectHash)),
            ];

            const sizeByHash = new Map<string, number>();
            if (blobHashes.length > 0) {
                const blobs = await db.prisma.blob.findMany({
                    where: { blobHash: { in: blobHashes } },
                    select: { blobHash: true, size: true },
                });
                for (const b of blobs) {
                    sizeByHash.set(b.blobHash, Number(b.size));
                }
            }

            const formattedTree = entries.map((e) => ({
                name: e.name,
                type: e.entryType,
                objectHash: e.objectHash,
                ...(e.entryType === "blob" && { size: sizeByHash.get(e.objectHash) }),
            }));

            res.status(200).json({
                status: "success",
                message: "Repository data fetched successfully.",
                data: {
                    tree: formattedTree
                }
            });
        } catch (err) {
            handleError("/api/repo/:repoId/data", err, next);
        }
    }
}
