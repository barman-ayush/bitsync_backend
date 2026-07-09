import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { createPullRequestSchema, prSchema, listPrQuerySchema, prDetailsSchema, createCommentSchema, deleteCommentSchema } from "../validators/pr.validators";
import db from "../services/database.service";
import storageService from "../services/storage.service";
import notificationService from "../services/notification.service";
import { repositoryId } from "../validators/repo.validator";
import { DiffEntry } from "../types/storage.types";


export class PRController {
    static async fetchAllPRs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Unauthorized");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            const allPRs = await db.prisma.pullRequest.findMany({
                where: { repoId, workspaceId }
            });

            if (!allPRs) throw new NotFoundError("No Pull Requests found");

            res.status(200).json({
                status: "success",
                data: allPRs
            })

        } catch (err) {
            handleError("/api/pr/", err, next);
        }
    }

    static async fetchPrCommits(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Unauthorized");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            const repoHead = await db.prisma.repository.findFirst({
                where: { id: repoId },
                select: { headCommit: true }
            });

            if (!repoHead) throw new NotFoundError("No Repository found");
            if (!repoHead?.headCommit) {
                const commitTrail = await db.prisma.commit.findMany({
                    where: {
                        parentWorkspaceId: workspaceId
                    },
                    select: {
                        message: true, commitHash: true, timestamp: true
                    }
                });
                const sortedCommits = commitTrail.sort(
                    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
                );


                res.status(200).json({
                    status: "success",
                    data: sortedCommits
                })
                return;
            }

            const workspaceHead = await db.prisma.workspace.findFirst({
                where: { repoId, id: workspaceId, userId: req.user.sub },
                select: { head: true }
            });

            if (!workspaceHead) throw new NotFoundError("No such Workspace found");
            if (!workspaceHead.head) throw new BadRequestError("No head commit found for this workspace");


            const workspaceCommitTrail: (string | null)[] = await storageService.mergeBase(repoHead.headCommit, workspaceHead.head);

            if (workspaceCommitTrail.length == 0) throw new BadRequestError("No commit trail found !");

            const commitDetails = await db.prisma.commit.findMany({
                where: {

                    commitHash: {
                        in: workspaceCommitTrail.filter((c) => c !== null)
                    }
                },
                select: {
                    message: true,
                    commitHash: true,
                    timestamp: true
                }
            });
            const sortedCommits = commitDetails.sort(
                (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
            );

            res.status(200).json({
                status: "success",
                data: sortedCommits
            });
        } catch (err) {
            handleError("/api/pr/commit-trail/:repoId/:workspaceId", err, next);
        }
    }

    static async createPullRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const parsedBody = createPullRequestSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);


            const { repoId, workspaceId } = parsed.data;
            const { title, description } = parsedBody.data;

            const repositoryActive = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false }
            });

            const workspaceExists = await db.prisma.workspace.findUnique({
                where: { repoId, id: workspaceId, userId },
            });
            // Repository validation
            if (!repositoryActive) throw new NotFoundError("No active repository found")

            // Workspace Validation
            if (!workspaceExists) throw new NotFoundError("No such Workspace found");
            if (!workspaceExists.head) throw new BadRequestError("Cannot create PR for a empty workspace");
            if (workspaceExists.repoId != repoId || workspaceExists.userId != userId) throw new BadRequestError("Invalid workspace");

            // if (repositoryActive.headCommit) {
            //     const commitTrail = await storageService.mergeBase(repositoryActive.headCommit, workspaceExists.head);
            //     if (commitTrail[0] == workspaceExists.head) throw new BadRequestError("Cannot create PR for empty workspace, need at least one commit.");
            // }
            const isActivePR = await db.prisma.pullRequest.findFirst({
                where: { repoId, workspaceId, status: "OPEN" }
            });
            if (isActivePR) throw new BadRequestError("Active PR already exists for this workspace");

            const pendingChanges = await db.prisma.workspaceChange.findFirst({ where: { workspaceId: workspaceExists.id } });
            if (pendingChanges) throw new BadRequestError("Pending changes found in workspace, please commit them before creating a PR");

            const threeWayMergeResults = await storageService.threeWayTreeMerge(repositoryActive.headCommit, workspaceExists.head);

            const hasConflicts = threeWayMergeResults.conflicts.length > 0;

            const { reviewers } = parsedBody.data;
            const reviewerUsers = !hasConflicts
                ? await db.prisma.user.findMany({
                    where: { email: { in: reviewers ?? [] } }
                })
                : [];

            const { pr: prCreated, mergeStateId } = await db.prisma.$transaction(async (tx) => {
                const pr = await tx.pullRequest.create({
                    data: {
                        repoId: repoId,
                        workspaceId: workspaceId,
                        title: title,
                        description: description,
                        authorId: userId,
                        prHead: workspaceExists.head!,
                        status: "OPEN",
                        createdAt: new Date(),
                    }
                });

                let mergeStateId: string | null = null;

                if (hasConflicts) {
                    const mergeState = await tx.mergeState.create({
                        data: {
                            prId: pr.id,
                            workspaceId: workspaceId,
                            baseCommit: threeWayMergeResults.baseCommit ?? "",
                            oursCommit: repositoryActive.headCommit ?? "",
                            theirsCommit: workspaceExists.head!,
                            status: "IN_PROGRESS",
                            mergedTree: null
                        }
                    });
                    mergeStateId = mergeState.id;

                    if (threeWayMergeResults.conflicts.length > 0) {
                        await tx.mergeConflict.createMany({
                            data: threeWayMergeResults.conflicts.map((conflict) => ({
                                mergeStateId: mergeState.id,
                                filePath: conflict.filePath,
                                conflictType: conflict.conflictType,
                                baseBlob: conflict.baseBlob,
                                oursBlob: conflict.oursBlob,
                                theirsBlob: conflict.theirsBlob,
                                resolution: "PENDING"
                            }))
                        });
                    }

                    await tx.workspace.update({
                        where: { id: workspaceId },
                        data: { status: "CONFLICTED" }
                    });
                } else {
                    if (reviewerUsers.length > 0) {
                        await tx.prReview.createMany({
                            data: reviewerUsers.map((u) => ({
                                prId: pr.id,
                                reviewerId: u.id,
                                verdict: "PENDING"
                            }))
                        });
                    }
                }

                return { pr, mergeStateId };
            });

            if (hasConflicts) {
                // Notify PR author about conflicts
                try {
                    await notificationService.notify({
                        userId: userId,
                        actorId: null,
                        type: "merge_conflicts",
                        context: {
                            actorName: "System",
                            repoName: repositoryActive.name,
                            prTitle: title,
                            conflictCount: threeWayMergeResults.conflicts.length
                        },
                        data: {
                            repoId,
                            prId: prCreated.id,
                            mergeStateId: mergeStateId ?? ""
                        }
                    });
                } catch (notifyErr) {
                    // Log and swallow notification errors
                }
            } else {
                // NO CONFLICTS: Send for review to those who are concerned + notification

                (async () => {
                    try {
                        const adminsAndOwners = await db.prisma.repoMember.findMany({
                            where: {
                                repoId,
                                role: { in: ["owner", "admin"] },
                                deletedAt: null,
                            },
                            select: { userId: true }
                        });

                        const recipients = new Set<string>();
                        adminsAndOwners.forEach((m) => recipients.add(m.userId));
                        recipients.add(repositoryActive.ownerId);
                        reviewerUsers.forEach((u) => recipients.add(u.id));

                        // Remove PR author from recipients
                        recipients.delete(req.user!.sub);

                        const actorName = (await db.prisma.user.findFirst({ where: { id: req.user?.sub }, select: { displayName: true } }))?.displayName || "Someone";

                        for (const recipientId of recipients) {
                            await notificationService.notify({
                                userId: recipientId,
                                actorId: req.user!.sub,
                                type: "pr_created",
                                context: {
                                    actorName,
                                    repoName: repositoryActive.name,
                                    prTitle: title,
                                },
                                data: {
                                    repoId,
                                    prId: prCreated.id,
                                }
                            });
                        }
                    } catch (notifyErr) {
                        // Log and swallow notification errors
                    }
                })();
            }

            res.status(201).json({
                status: "success",
                data: prCreated
            });
        } catch (err) {
            handleError("/api/pr/create/:repoId/:workspaceId", err, next);
        }

    }

    static async getPRStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false }
            })

            const workspace = await db.prisma.workspace.findUnique({
                where: { repoId, id: workspaceId }
            })
            if (!repository || !workspace) throw new BadRequestError("No such workspace or repository found");

            const isActivePR = await db.prisma.pullRequest.findFirst({
                where: { repoId, workspaceId, status: { in: ["OPEN", "DIFFING"] } }
            });

            const status = (!isActivePR) ? "CREATE_PR" : "VIEW_PR";

            res.status(200).json({
                status: "success",
                data: {
                    status, prData: isActivePR
                }
            });
        } catch (err) {
            handleError("/api/pr/get-status/:repoId/:workspaceId", err, next);
        }
    }

    static async getAllPRs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = repositoryId.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const parsedQuery = listPrQuerySchema.safeParse(req.query);
            if (!parsedQuery.success) throw new BadRequestError(parsedQuery.error.issues[0].message);

            const { repoId } = parsed.data;
            const { cursor, limit, q } = parsedQuery.data;

            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false }
            });
            if (!repository) throw new BadRequestError("Repository not found");

            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const queryWhere: any = { repoId };
            if (membership === "member") {
                queryWhere.authorId = req.user.sub;
            }
            if (q) {
                queryWhere.OR = [
                    { title: { contains: q, mode: "insensitive" } },
                    { description: { contains: q, mode: "insensitive" } },
                ];
            }

            const rows = await db.prisma.pullRequest.findMany({
                where: queryWhere,
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                ...(cursor && { cursor: { id: cursor }, skip: 1 }),
                include: membership !== "member" ? { workspace: true } : undefined,
            });

            const hasMore = rows.length > limit;
            const allPrs = hasMore ? rows.slice(0, limit) : rows;
            const nextCursor = hasMore ? allPrs[allPrs.length - 1].id : null;

            res.status(200).json({
                status: "success",
                data: allPrs,
                pagination: { nextCursor, hasMore }
            });

        } catch (err) {
            handleError("/api/pr/list/:repoId", err, next);
        }
    }
    static async getPrDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const membership = req.membership?.role;
            if (!req.user || !membership) throw new UnauthorizedError("Unauthorized");

            const parsed = prDetailsSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, prId } = parsed.data;

            const isRepoActive = await db.prisma.repository.findUnique({ where: { id: repoId, isDeleted: false } });

            if (!isRepoActive) throw new BadRequestError("No such repository exists");

            const pullRequest = await db.prisma.pullRequest.findFirst({
                where: { repoId, id: prId },
                include: {
                    author: true,
                    workspace: true,
                    comments: {
                        include: {
                            author: {
                                select: { id: true, username: true, displayName: true, avatarUrl: true }
                            }
                        },
                        orderBy: { createdAt: "asc" }
                    }
                }
            });

            if (!pullRequest) throw new NotFoundError("No such Pull Request found");
            if ((membership == "member") && (req.user.sub != pullRequest?.authorId)) throw new UnauthorizedError("This PR does not belong to you");

            res.status(200).json({
                status: "success",
                data: pullRequest
            });


        } catch (err) {
            handleError("/api/pr/details/:repoId/:prId", err, next);
        }
    }

    static async getPrCommitChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            // Validate repo exists and is active.
            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false },
                select: { headCommit: true },
            });
            if (!repository) throw new NotFoundError("Repository not found");

            const workspace = await db.prisma.workspace.findFirst({
                where: {
                    id: workspaceId,
                }
            });

            if (!workspace) throw new NotFoundError("Workspace not found!");
            if (!workspace.head) throw new BadRequestError("Workspace head not found!");

            // Members can only view their own PRs.
            if (membership === "member" && req.user.sub !== workspace.userId) {
                throw new UnauthorizedError("This PR does not belong to you");
            }

            // Resolve the root tree for the PR's head commit.
            const prCommit = (workspace.head) ? await db.prisma.commit.findUnique({
                where: { commitHash: workspace.head },
                select: { rootTree: true },
            }) : null;
            if (!prCommit) throw new NotFoundError("PR head commit not found");

            // Find the LCA commit trail (repo.headCommit can be null, which mergeBase supports)
            const baseCommitTrail = await storageService.mergeBase(repository.headCommit, workspace.head);
            if (baseCommitTrail.length === 0) throw new NotFoundError("No base commit found for workspace");
            for (let i = 0; i < baseCommitTrail.length; i++) {
                console.log(i, baseCommitTrail[i]);
            }

            // Fetch the root tree hash of the LCA commit (baseCommitTrail[0])
            const baseCommitRecord = await db.prisma.commit.findUnique({
                where: { commitHash: baseCommitTrail[0] ?? "" },
                select: { rootTree: true }
            });
            const baseTreeHash = baseCommitRecord?.rootTree ?? null;

            // Compute the diff between the LCA tree and the Workspace tree
            const diff = await storageService.getTreeDiff(baseTreeHash, prCommit.rootTree);

            res.status(200).json({
                status: "success",
                data: diff,
            });
        } catch (err) {
            handleError("/api/pr/diff/:repoId/:prId", err, next);
        }
    }

    static async addComment(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsedParams = prDetailsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedBody = createCommentSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);

            const { repoId, prId } = parsedParams.data;
            const { body, filePath } = parsedBody.data;

            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false },
                select: { id: true, name: true, ownerId: true }
            });
            if (!repository) throw new NotFoundError("Repository not found");

            const pullRequest = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId },
                select: { id: true, title: true, authorId: true }
            });
            if (!pullRequest) throw new NotFoundError("Pull Request not found");

            const comment = await db.prisma.prComment.create({
                data: {
                    prId,
                    authorId: req.user.sub,
                    body,
                    filePath: filePath ?? null,
                },
                include: {
                    author: {
                        select: { id: true, username: true, displayName: true, avatarUrl: true }
                    }
                }
            });

            // Notify repository owners, admins, and PR author (excluding commenter)
            (async () => {
                try {
                    const adminsAndOwners = await db.prisma.repoMember.findMany({
                        where: {
                            repoId,
                            role: { in: ["owner", "admin"] },
                            deletedAt: null,
                        },
                        select: { userId: true }
                    });

                    const recipients = new Set<string>();
                    adminsAndOwners.forEach((m) => recipients.add(m.userId));
                    recipients.add(repository.ownerId);
                    recipients.add(pullRequest.authorId);

                    // Remove commenter from notification recipients
                    recipients.delete(req.user!.sub);

                    const actorName = (await db.prisma.user.findFirst({ where: { id: req.user?.sub }, select: { displayName: true } }))?.displayName || "Someone";

                    // const actorName = req.user!.displayName || req.user!.username || "Someone";

                    for (const recipientId of recipients) {
                        await notificationService.notify({
                            userId: recipientId,
                            actorId: req.user!.sub,
                            type: "pr_reviewed",
                            context: {
                                actorName,
                                repoName: repository.name,
                                prTitle: pullRequest.title,
                            },
                            data: {
                                repoId,
                                prId,
                                commentId: comment.id,
                            }
                        });
                    }
                } catch (notifyErr) {
                    // Failures in notification sending are logged and swallowed
                }
            })();

            res.status(201).json({
                status: "success",
                data: comment
            });
        } catch (err) {
            handleError("/api/pr/comment/:repoId/:prId", err, next);
        }
    }

    static async deleteComment(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = deleteCommentSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, prId, commentId } = parsed.data;

            const comment = await db.prisma.prComment.findUnique({
                where: { id: commentId },
                include: { pr: true }
            });

            if (!comment || comment.prId !== prId || comment.pr.repoId !== repoId) {
                throw new NotFoundError("Comment not found");
            }

            const membershipRole = req.membership?.role;
            const isAuthor = comment.authorId === req.user.sub;
            const isAdminOrOwner = membershipRole === "owner" || membershipRole === "admin";

            if (!isAuthor && !isAdminOrOwner) {
                throw new ForbiddenError("You do not have permission to delete this comment");
            }

            await db.prisma.prComment.delete({
                where: { id: commentId }
            });

            res.status(200).json({
                status: "success",
                message: "Comment deleted successfully"
            });
        } catch (err) {
            handleError("/api/pr/comment/:repoId/:prId/:commentId", err, next);
        }
    }

    // getMergeCheck : preview the three-way merge result between repo HEAD and
    // workspace HEAD without creating any database records. The frontend calls
    // this from the draft PR view so the user can see conflicts before
    // officially creating or merging the PR.
    //
    // Returns: canMerge, isFastForward, conflict list, and summary stats.
    static async getMergeCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            // Validate repo exists and is active.
            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false },
                select: { headCommit: true },
            });
            if (!repository) throw new NotFoundError("Repository not found");

            // Load the workspace and verify ownership.
            const workspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId, repoId },
                select: { head: true, userId: true },
            });
            if (!workspace) throw new NotFoundError("Workspace not found");

            // Members can only check their own workspaces.
            if (membership === "member" && workspace.userId !== req.user.sub) {
                throw new UnauthorizedError("This workspace does not belong to you");
            }

            if (!workspace.head) {
                throw new BadRequestError("Workspace has no commits — nothing to merge");
            }

            // Run the three-way merge algorithm (read-only preview).
            const mergeResult = await storageService.threeWayTreeMerge(
                repository.headCommit,
                workspace.head,
            );

            res.status(200).json({
                status: "success",
                data: mergeResult,
            });
        } catch (err) {
            handleError("/api/pr/merge-check/:repoId/:workspaceId", err, next);
        }
    }

    // closePR : close an OPEN pull request (spec §4.5).
    // Can only be performed by the PR author or repository admins/owners.
    static async closePR(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = prDetailsSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, prId } = parsed.data;

            const repository = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false },
                select: { id: true, name: true }
            });
            if (!repository) throw new NotFoundError("Repository not found");

            const pullRequest = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId }
            });
            if (!pullRequest) throw new NotFoundError("Pull Request not found");

            if (pullRequest.status !== "OPEN") {
                throw new BadRequestError(`Cannot close a PR with status '${pullRequest.status}'. Only OPEN PRs can be closed.`);
            }

            const membershipRole = req.membership?.role;
            const isAuthor = pullRequest.authorId === req.user.sub;
            const isAdminOrOwner = membershipRole === "owner" || membershipRole === "admin";

            if (!isAuthor && !isAdminOrOwner) {
                throw new ForbiddenError("You do not have permission to close this pull request");
            }

            const updatedPR = await db.prisma.pullRequest.update({
                where: { id: prId },
                data: {
                    status: "CLOSED",
                    updatedAt: new Date()
                }
            });

            // Notify PR author if closed by someone else
            if (req.user.sub !== pullRequest.authorId) {
                (async () => {
                    try {
                        const actorName = (await db.prisma.user.findFirst({ where: { id: req.user?.sub }, select: { displayName: true } }))?.displayName || "Someone";
                        await notificationService.notify({
                            userId: pullRequest.authorId,
                            actorId: req.user!.sub,
                            type: "pr_rejected",
                            context: {
                                actorName,
                                repoName: repository.name,
                                prTitle: pullRequest.title,
                            },
                            data: {
                                repoId,
                                prId,
                                closedBy: req.user!.sub,
                            }
                        });
                    } catch (notifyErr) {
                        // Log and swallow notification errors
                    }
                })();
            }

            res.status(200).json({
                status: "success",
                data: updatedPR
            });
        } catch (err) {
            handleError("/api/pr/close/:repoId/:prId", err, next);
        }
    }
    static async someFunction(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
        } catch (err) {
            handleError("/api/pr/changes/:repoId/:prId", err, next);
        }
    }
}