import { NextFunction, Request, Response } from "express";
import { ConflictResolution } from "../generated/prisma/client";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { createPullRequestSchema, prSchema, listPrQuerySchema, prDetailsSchema, createCommentSchema, deleteCommentSchema, resolveConflictsSchema, prMergeabilitySchema, listAssignedReviewsSchema, listAssignedReviewsQuerySchema, reviewerPrViewSchema, addReviewersSchema, submitReviewSchema, prReviewStatusSchema } from "../validators/pr.validators";
import { hashCommit } from "../utils/blob.utils";
import db from "../services/database.service";
import storageService from "../services/storage.service";
import notificationService from "../services/notification.service";
import { repositoryId } from "../validators/repo.validator";
import { DiffEntry, BuildTreeChange } from "../types/storage.types";


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


            const [repoHead, workspaceHead] = await Promise.all([
                db.prisma.repository.findFirst({
                    where: { id: repoId },
                    select: { headCommit: true }
                }),
                db.prisma.workspace.findFirst({
                    where: { repoId, id: workspaceId },
                    select: { head: true }
                })
            ]);

            if (!repoHead) throw new NotFoundError("No Repository found");
            if (!workspaceHead) throw new NotFoundError("No such Workspace found");

            const pr = await db.prisma.pullRequest.findFirst({
                where: { workspaceId, repoId },
                orderBy: { createdAt: "desc" }
            });

            let workspaceCommitTrail: (string | null)[] = [];

            if (pr && pr.status === "MERGED" && workspaceHead.head === pr.prHead) {
                workspaceCommitTrail = await storageService.mergeBase(pr.baseCommit, pr.prHead);
            } else if (!repoHead.headCommit) {
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
                });
                return;
            } else {
                if (!workspaceHead.head) throw new BadRequestError("No head commit found for this workspace");

                workspaceCommitTrail = await storageService.mergeBase(repoHead.headCommit, workspaceHead.head);
            }

            const commitsToFetch = workspaceCommitTrail.slice(1).filter((c): c is string => c !== null);

            if (commitsToFetch.length === 0) {
                throw new BadRequestError("No commit trail found !");
            }

            const commitDetails = await db.prisma.commit.findMany({
                where: {
                    commitHash: {
                        in: commitsToFetch
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

            // Validate reviewers array
            const { reviewers } = parsedBody.data;
            const repoData = await db.prisma.repository.findUnique({
                where: { id: repoId },
                include: {
                    members: {
                        where: { deletedAt: null }
                    }
                }
            });
            if (!repoData) throw new NotFoundError("Repository not found");

            const memberCount = repoData.members.length;
            let validReviewerUsers = [];

            if (memberCount > 1) {
                if (!reviewers || reviewers.length === 0) {
                    throw new BadRequestError("At least one reviewer is required bahencjhid.");
                }

                const reviewerUsers = await db.prisma.user.findMany({
                    where: { email: { in: reviewers } }
                });
                const reviewerUserIds = reviewerUsers.map((u) => u.id);

                validReviewerUsers = await PRController.validateReviewersHelper(repoId, reviewerUserIds, userId);
            }

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

                // Create PrReview records for all valid reviewers
                if (validReviewerUsers.length > 0) {
                    await tx.prReview.createMany({
                        data: validReviewerUsers.map((u) => ({
                            prId: pr.id,
                            reviewerId: u.id,
                            verdict: "PENDING"
                        }))
                    });
                }

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
                        const conflicts = await tx.mergeConflict.createMany({
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
                        validReviewerUsers.forEach((u) => recipients.add(u.id));

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
                where: { repoId, workspaceId, status: { in: ["OPEN"] } }
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

    static async validateReviewersHelper(
        repoId: string,
        reviewerUserIds: string[],
        authorId: string
    ): Promise<any[]> {
        if (reviewerUserIds.length === 0) {
            throw new BadRequestError("At least one reviewer is required.");
        }

        const reviewerUsers = await db.prisma.user.findMany({
            where: { id: { in: reviewerUserIds } }
        });

        if (reviewerUsers.length === 0) {
            throw new BadRequestError("No valid users found for the provided reviewer IDs.");
        }

        // Filter for members of the repo who are admin or owner (at least admins)
        const validMembers = await db.prisma.repoMember.findMany({
            where: {
                repoId,
                userId: { in: reviewerUserIds },
                role: { in: ["admin", "owner"] },
                deletedAt: null
            }
        });

        if (validMembers.length === 0) {
            throw new BadRequestError("At least one valid reviewer (repo owner or admin) is required.");
        }

        // Map validReviewerUsers to only those who are valid members and not the author
        const validMemberUserIds = new Set(validMembers.map((m) => m.userId));
        const validReviewerUsers = reviewerUsers.filter((u) => validMemberUserIds.has(u.id) && u.id !== authorId);

        if (validReviewerUsers.length === 0) {
            throw new BadRequestError("You cannot assign yourself or non-admin members as reviewers.");
        }

        return validReviewerUsers;
    }

    static async getPrChangesHelper(repoId: string, workspaceId: string): Promise<DiffEntry[]> {
        const repository = await db.prisma.repository.findUnique({
            where: { id: repoId, isDeleted: false },
            select: { headCommit: true },
        });
        if (!repository) throw new NotFoundError("Repository not found");

        const workspace = await db.prisma.workspace.findUnique({
            where: { id: workspaceId }
        });
        if (!workspace) throw new NotFoundError("Workspace not found!");
        if (!workspace.head) throw new BadRequestError("Workspace head not found!");

        const prCommit = await db.prisma.commit.findUnique({
            where: { commitHash: workspace.head },
            select: { rootTree: true },
        });
        if (!prCommit) throw new NotFoundError("PR head commit not found");

        const baseCommitTrail = await storageService.mergeBase(repository.headCommit, workspace.head);
        if (baseCommitTrail.length === 0) throw new NotFoundError("No base commit found for workspace");

        const baseCommitRecord = await db.prisma.commit.findUnique({
            where: { commitHash: baseCommitTrail[0] ?? "" },
            select: { rootTree: true }
        });
        const baseTreeHash = baseCommitRecord?.rootTree ?? null;

        return storageService.getTreeDiff(baseTreeHash, prCommit.rootTree);
    }

    static async getPrCommitChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId } = parsed.data;

            // Members can only view their own PRs.
            if (membership === "member") {
                const workspace = await db.prisma.workspace.findUnique({
                    where: { id: workspaceId },
                    select: { userId: true }
                });
                if (!workspace || req.user.sub !== workspace.userId) {
                    throw new UnauthorizedError("This PR does not belong to you");
                }
            }

            const diff = await PRController.getPrChangesHelper(repoId, workspaceId);

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
            const userId = req.user.sub;
            const isPrAuthor = pullRequest.authorId === userId;
            const isRepoOwner = repository.ownerId === userId;

            const isAssignedReviewer = await db.prisma.prReview.findFirst({
                where: { prId, reviewerId: userId }
            });

            if (!isPrAuthor && !isRepoOwner && !isAssignedReviewer) {
                throw new ForbiddenError("You do not have permission to comment on this Pull Request. Only the PR author, assigned reviewers, or repository owner can comment.");
            }

            const comment = await db.prisma.prComment.create({
                data: {
                    prId,
                    authorId: userId,
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

            const updatedPR = await db.prisma.$transaction(async (tx) => {
                const pr = await tx.pullRequest.update({
                    where: { id: prId },
                    data: {
                        status: "CLOSED",
                        updatedAt: new Date()
                    }
                });

                // Explicitly delete MergeConflicts related to this PR
                await tx.mergeConflict.deleteMany({
                    where: {
                        mergeState: {
                            prId: prId
                        }
                    }
                });

                // Delete MergeState records for this PR
                await tx.mergeState.deleteMany({
                    where: { prId }
                });

                // Restore workspace status to CLEAN
                if (pullRequest.workspaceId) {
                    await tx.workspace.update({
                        where: { id: pullRequest.workspaceId },
                        data: { status: "CLEAN" }
                    });
                }

                await tx.prReview.updateMany({
                    where: { prId },
                    data: { verdict: "PR_CLOSED" }
                });

                return pr;
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
    static async reEvaluateConflictsHelper(
        tx: any,
        pr: any,
        mergeState: any,
        newOursCommit: string,
        newTheirsCommit: string
    ): Promise<any> {
        const mergeBaseTrail = await storageService.mergeBase(newOursCommit, newTheirsCommit);
        const newBaseCommit = mergeBaseTrail.length > 0 ? mergeBaseTrail[0] : null;
        if (!newBaseCommit) {
            throw new BadRequestError("No common ancestor found");
        }

        const reEvaluation = await storageService.threeWayTreeMerge(newOursCommit, newTheirsCommit);

        await tx.mergeState.update({
            where: { id: mergeState.id },
            data: {
                oursCommit: newOursCommit,
                theirsCommit: newTheirsCommit,
                baseCommit: newBaseCommit,
                status: reEvaluation.conflicts.length === 0 ? "RESOLVED" : "IN_PROGRESS",
                updatedAt: new Date()
            }
        });

        const existingConflicts = await tx.mergeConflict.findMany({
            where: { mergeStateId: mergeState.id }
        });

        const existingMap = new Map<string, any>(existingConflicts.map((c: any) => [c.filePath, c]));
        const newConflictingPaths = new Set<string>(reEvaluation.conflicts.map((c: any) => c.filePath));

        for (const c of reEvaluation.conflicts) {
            const existing = existingMap.get(c.filePath);
            if (existing) {
                const isIdentical = existing.conflictType === c.conflictType &&
                    existing.baseBlob === c.baseBlob &&
                    existing.oursBlob === c.oursBlob &&
                    existing.theirsBlob === c.theirsBlob;

                if (!isIdentical) {
                    await tx.mergeConflict.update({
                        where: { id: existing.id },
                        data: {
                            conflictType: c.conflictType,
                            baseBlob: c.baseBlob,
                            oursBlob: c.oursBlob,
                            theirsBlob: c.theirsBlob,
                            resolution: "PENDING",
                            resolvedBlob: null,
                            resolvedAt: null
                        }
                    });
                }
            } else {
                await tx.mergeConflict.create({
                    data: {
                        mergeStateId: mergeState.id,
                        filePath: c.filePath,
                        conflictType: c.conflictType,
                        baseBlob: c.baseBlob,
                        oursBlob: c.oursBlob,
                        theirsBlob: c.theirsBlob,
                        resolution: "PENDING"
                    }
                });
            }
        }

        for (const existing of existingConflicts) {
            if (!newConflictingPaths.has(existing.filePath)) {
                await tx.mergeConflict.delete({
                    where: { id: existing.id }
                });
            }
        }

        if (reEvaluation.conflicts.length === 0) {
            await tx.workspace.update({
                where: { id: pr.workspaceId! },
                data: { status: "CLEAN" }
            });
        } else {
            await tx.workspace.update({
                where: { id: pr.workspaceId! },
                data: { status: "CONFLICTED" }
            });
        }

        return tx.mergeConflict.findMany({
            where: { mergeStateId: mergeState.id }
        });
    }

    static async resolveConflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsedParams = prDetailsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedBody = resolveConflictsSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);

            const { repoId, prId } = parsedParams.data;
            const { resolutions } = parsedBody.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId },
                include: {
                    workspace: true,
                    repo: true,
                    mergeStates: {
                        where: { status: "IN_PROGRESS" },
                        include: { conflicts: true }
                    }
                }
            });

            if (!pr) throw new NotFoundError("Pull Request not found");
            if (pr.status !== "OPEN") throw new BadRequestError("Pull Request is not OPEN");
            if (!pr.workspaceId) throw new NotFoundError("Workspace not found");

            const ms = await db.prisma.mergeState.findMany({
                where: {
                    workspaceId: pr.workspaceId,
                    status: "IN_PROGRESS",
                    prId: pr.id
                }
            })

            const mergeState = pr.mergeStates[0];
            if (!mergeState) throw new BadRequestError("No active merge state found, Please close and open a new pull request");

            const result = await db.prisma.$transaction(async (tx) => {
                const dbConflicts = await tx.mergeConflict.findMany({
                    where: { mergeStateId: mergeState.id }
                });

                for (const resItem of resolutions) {
                    const conflict = dbConflicts.find(c => c.id === resItem.conflictId);
                    if (!conflict) {
                        throw new BadRequestError(`Conflict ${resItem.conflictId} not found in this merge state`);
                    }

                    let targetResolvedBlob: string | null = null;
                    if (resItem.resolution === "TAKE_OURS") {
                        targetResolvedBlob = conflict.oursBlob;
                    } else if (resItem.resolution === "TAKE_THEIRS") {
                        targetResolvedBlob = conflict.theirsBlob;
                    } else if (resItem.resolution === "MANUAL") {
                        targetResolvedBlob = resItem.resolvedBlob ?? null;
                    }

                    await tx.mergeConflict.update({
                        where: { id: conflict.id },
                        data: {
                            resolution: resItem.resolution,
                            resolvedBlob: targetResolvedBlob,
                            resolvedAt: new Date()
                        }
                    });
                }

                const pendingCount = await tx.mergeConflict.count({
                    where: {
                        mergeStateId: mergeState.id,
                        resolution: "PENDING"
                    }
                });

                if (pendingCount > 0) {
                    return {
                        gitHistoryChanged: false,
                        pendingConflictCount: pendingCount
                    };
                }

                const [currentWorkspace, currentRepo] = await Promise.all([
                    tx.workspace.findUnique({
                        where: { id: pr.workspaceId! },
                        select: { head: true }
                    }),
                    tx.repository.findUnique({
                        where: { id: repoId },
                        select: { headCommit: true }
                    })
                ]);

                if (!currentWorkspace || !currentRepo) {
                    throw new NotFoundError("Workspace or Repository not found");
                }

                const isUpToDate = (currentWorkspace.head === mergeState.theirsCommit) &&
                    (currentRepo.headCommit === mergeState.oursCommit);

                if (isUpToDate) {
                    await tx.mergeState.update({
                        where: { id: mergeState.id },
                        data: {
                            status: "RESOLVED",
                            updatedAt: new Date()
                        }
                    });
                    return {
                        gitHistoryChanged: false,
                        mergeStateStatus: "RESOLVED"
                    };
                }

                const newOursCommit = currentRepo.headCommit;
                const newTheirsCommit = currentWorkspace.head;
                if (!newOursCommit || !newTheirsCommit) {
                    throw new BadRequestError("Invalid branch heads");
                }

                const updatedConflicts = await PRController.reEvaluateConflictsHelper(
                    tx,
                    pr,
                    mergeState,
                    newOursCommit,
                    newTheirsCommit
                );

                return {
                    gitHistoryChanged: true,
                    conflicts: updatedConflicts
                };
            });

            if (result.gitHistoryChanged) {
                res.status(200).json({
                    status: "success",
                    message: "Git history has changed. Please update the given conflicts.",
                    data: result
                });
            } else {
                res.status(200).json({
                    status: "success",
                    message: result.mergeStateStatus === "RESOLVED"
                        ? "All conflicts resolved successfully. Ready to merge."
                        : "Resolutions saved successfully.",
                    data: result
                });
            }

        } catch (err) {
            handleError("/api/pr/resolve-conflicts/:repoId/:prId", err, next);
        }
    }

    static async mergePullRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsedParams = prDetailsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const { repoId, prId } = parsedParams.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId },
                include: {
                    workspace: true,
                    repo: true,
                    mergeStates: {
                        where: { status: { in: ["IN_PROGRESS", "RESOLVED"] } },
                        include: { conflicts: true }
                    }
                }
            });

            if (!pr) throw new NotFoundError("Pull Request not found");
            if (pr.status !== "OPEN") throw new BadRequestError("Pull Request is not OPEN");
            if (!pr.workspaceId || !pr.workspace) throw new NotFoundError("Workspace not found");

            const mergeState = pr.mergeStates[0];

            const result = await db.prisma.$transaction(async (tx) => {
                const [currentWorkspace, currentRepo] = await Promise.all([
                    tx.workspace.findUnique({
                        where: { id: pr.workspaceId! },
                        select: { head: true }
                    }),
                    tx.repository.findUnique({
                        where: { id: repoId },
                        select: { headCommit: true }
                    })
                ]);

                if (!currentWorkspace || !currentRepo) {
                    throw new NotFoundError("Workspace or Repository not found");
                }

                if (mergeState) {
                    const isUpToDate = (currentWorkspace.head === mergeState.theirsCommit) &&
                        (currentRepo.headCommit === mergeState.oursCommit);

                    if (!isUpToDate) {
                        const newOursCommit = currentRepo.headCommit;
                        const newTheirsCommit = currentWorkspace.head;
                        if (!newOursCommit || !newTheirsCommit) {
                            throw new BadRequestError("Invalid branch heads");
                        }

                        const updatedConflicts = await PRController.reEvaluateConflictsHelper(
                            tx,
                            pr,
                            mergeState,
                            newOursCommit,
                            newTheirsCommit
                        );

                        return {
                            status: "GIT_HISTORY_CHANGED",
                            conflicts: updatedConflicts
                        };
                    }

                    const pendingCount = await tx.mergeConflict.count({
                        where: {
                            mergeStateId: mergeState.id,
                            resolution: "PENDING"
                        }
                    });

                    if (pendingCount > 0) {
                        return {
                            status: "UNRESOLVED_CONFLICTS",
                            pendingCount
                        };
                    }

                    const mergeResult = await storageService.threeWayTreeMerge(
                        mergeState.oursCommit,
                        mergeState.theirsCommit
                    );

                    const resolvedConflicts = await tx.mergeConflict.findMany({
                        where: { mergeStateId: mergeState.id }
                    });

                    const finalMergedMap: Record<string, string> = {};
                    for (const [path, entry] of Object.entries(mergeResult.mergedPaths)) {
                        if (entry.newBlobHash) {
                            finalMergedMap[path] = entry.newBlobHash;
                        }
                    }

                    for (const conflict of resolvedConflicts) {
                        if (conflict.resolvedBlob) {
                            finalMergedMap[conflict.filePath] = conflict.resolvedBlob;
                        } else {
                            delete finalMergedMap[conflict.filePath];
                        }
                    }

                    const oursCommitRecord = await tx.commit.findUnique({
                        where: { commitHash: mergeState.oursCommit },
                        select: { rootTree: true }
                    });
                    if (!oursCommitRecord) {
                        throw new BadRequestError("Repository ours commit record not found");
                    }

                    const oursMap = await storageService.flatten_tree(oursCommitRecord.rootTree);
                    const oursBlobs: Record<string, string> = {};
                    for (const [path, info] of Object.entries(oursMap)) {
                        if (info.type === "blob") {
                            oursBlobs[path] = info.hash;
                        }
                    }

                    const changes: BuildTreeChange[] = [];
                    for (const [path, newHash] of Object.entries(finalMergedMap)) {
                        const oldHash = oursBlobs[path];
                        if (!oldHash) {
                            changes.push({ filePath: path, action: "ADD", blobHash: newHash });
                        } else if (oldHash !== newHash) {
                            changes.push({ filePath: path, action: "MODIFY", blobHash: newHash });
                        }
                    }

                    for (const path of Object.keys(oursBlobs)) {
                        if (!finalMergedMap[path]) {
                            changes.push({ filePath: path, action: "DELETE", blobHash: null });
                        }
                    }

                    const finalRootTreeHash = await storageService.build_tree_from_changes(
                        { rootTree: oursCommitRecord.rootTree },
                        changes,
                        tx
                    );

                    const committedAt = new Date();
                    const timestamp = Math.floor(committedAt.getTime() / 1000);
                    const COMMIT_TIMEZONE = "+0530";
                    const message = `Merge PR #${pr.id}: ${pr.title}`;
                    const authorIdentity = { name: req.user!.name, email: req.user!.email };

                    const newMergeCommitHash = hashCommit({
                        rootTree: finalRootTreeHash,
                        parents: [mergeState.oursCommit, mergeState.theirsCommit],
                        author: authorIdentity,
                        timestamp,
                        timezone: COMMIT_TIMEZONE,
                        message
                    });

                    await tx.commit.create({
                        data: {
                            commitHash: newMergeCommitHash,
                            rootTree: finalRootTreeHash,
                            parent: mergeState.oursCommit,
                            author: `${authorIdentity.name} <${authorIdentity.email}>`,
                            timestamp: committedAt,
                            message,
                            parentWorkspaceId: null
                        }
                    });

                    await tx.commitParent.createMany({
                        data: [
                            { commitHash: newMergeCommitHash, parentHash: mergeState.oursCommit, ordinal: 0 },
                            { commitHash: newMergeCommitHash, parentHash: mergeState.theirsCommit, ordinal: 1 }
                        ]
                    });

                    const repoUpdate = await tx.repository.updateMany({
                        where: { id: repoId, headCommit: mergeState.oursCommit },
                        data: { headCommit: newMergeCommitHash }
                    });
                    if (repoUpdate.count === 0) {
                        throw new BadRequestError("Concurrent modification: Repository HEAD advanced. Please retry.");
                    }

                    await tx.pullRequest.update({
                        where: { id: prId },
                        data: {
                            status: "MERGED",
                            baseCommit: mergeState.baseCommit,
                            mergeCommit: newMergeCommitHash,
                            updatedAt: new Date()
                        }
                    });

                    const isWorkspaceFullyMerged = currentWorkspace.head === pr.prHead;
                    const workspaceDataToUpdate: any = {
                        status: "CLEAN",
                        updatedAt: new Date()
                    };
                    if (isWorkspaceFullyMerged) {
                        workspaceDataToUpdate.head = newMergeCommitHash;
                    }

                    await tx.workspace.update({
                        where: { id: pr.workspaceId! },
                        data: workspaceDataToUpdate
                    });

                    await tx.mergeState.update({
                        where: { id: mergeState.id },
                        data: {
                            status: "RESOLVED",
                            mergedTree: finalRootTreeHash,
                            updatedAt: new Date()
                        }
                    });

                    return {
                        status: "MERGED",
                        mergeCommitHash: newMergeCommitHash
                    };
                } else {
                    if (!currentWorkspace.head) {
                        throw new BadRequestError("Workspace has no head commit");
                    }

                    const mergeResult = await storageService.threeWayTreeMerge(
                        currentRepo.headCommit,
                        currentWorkspace.head
                    );

                    if (mergeResult.conflicts.length > 0) {
                        const newMergeState = await tx.mergeState.create({
                            data: {
                                prId: pr.id,
                                workspaceId: pr.workspaceId!,
                                baseCommit: mergeResult.baseCommit ?? "",
                                oursCommit: currentRepo.headCommit ?? "",
                                theirsCommit: currentWorkspace.head,
                                status: "IN_PROGRESS",
                                mergedTree: null
                            }
                        });

                        await tx.mergeConflict.createMany({
                            data: mergeResult.conflicts.map((c) => ({
                                mergeStateId: newMergeState.id,
                                filePath: c.filePath,
                                conflictType: c.conflictType,
                                baseBlob: c.baseBlob,
                                oursBlob: c.oursBlob,
                                theirsBlob: c.theirsBlob,
                                resolution: "PENDING"
                            }))
                        });

                        await tx.workspace.update({
                            where: { id: pr.workspaceId! },
                            data: { status: "CONFLICTED" }
                        });

                        return {
                            status: "CONFLICTS_DETECTED",
                            conflicts: mergeResult.conflicts
                        };
                    }

                    if (mergeResult.isFastForward) {
                        await tx.repository.updateMany({
                            where: { id: repoId, headCommit: currentRepo.headCommit },
                            data: { headCommit: currentWorkspace.head }
                        });

                        await tx.pullRequest.update({
                            where: { id: prId },
                            data: {
                                status: "MERGED",
                                baseCommit: mergeResult.baseCommit,
                                mergeCommit: currentWorkspace.head,
                                updatedAt: new Date()
                            }
                        });

                        await tx.workspace.update({
                            where: { id: pr.workspaceId! },
                            data: {
                                status: "CLEAN",
                                head: currentWorkspace.head,
                                updatedAt: new Date()
                            }
                        });

                        return {
                            status: "MERGED",
                            mergeCommitHash: currentWorkspace.head
                        };
                    } else {
                        const finalMergedMap: Record<string, string> = {};
                        for (const [path, entry] of Object.entries(mergeResult.mergedPaths)) {
                            if (entry.newBlobHash) {
                                finalMergedMap[path] = entry.newBlobHash;
                            }
                        }

                        const oursCommitRecord = await tx.commit.findUnique({
                            where: { commitHash: currentRepo.headCommit ?? "" },
                            select: { rootTree: true }
                        });
                        if (!oursCommitRecord) {
                            throw new BadRequestError("Repository ours commit record not found");
                        }

                        const oursMap = await storageService.flatten_tree(oursCommitRecord.rootTree);
                        const oursBlobs: Record<string, string> = {};
                        for (const [path, info] of Object.entries(oursMap)) {
                            if (info.type === "blob") {
                                oursBlobs[path] = info.hash;
                            }
                        }

                        const changes: BuildTreeChange[] = [];
                        for (const [path, newHash] of Object.entries(finalMergedMap)) {
                            const oldHash = oursBlobs[path];
                            if (!oldHash) {
                                changes.push({ filePath: path, action: "ADD", blobHash: newHash });
                            } else if (oldHash !== newHash) {
                                changes.push({ filePath: path, action: "MODIFY", blobHash: newHash });
                            }
                        }

                        for (const path of Object.keys(oursBlobs)) {
                            if (!finalMergedMap[path]) {
                                changes.push({ filePath: path, action: "DELETE", blobHash: null });
                            }
                        }

                        const finalRootTreeHash = await storageService.build_tree_from_changes(
                            { rootTree: oursCommitRecord.rootTree },
                            changes,
                            tx
                        );

                        const committedAt = new Date();
                        const timestamp = Math.floor(committedAt.getTime() / 1000);
                        const COMMIT_TIMEZONE = "+0530";
                        const message = `Merge PR #${pr.id}: ${pr.title}`;
                        const authorIdentity = { name: req.user!.name, email: req.user!.email };

                        const newMergeCommitHash = hashCommit({
                            rootTree: finalRootTreeHash,
                            parents: [currentRepo.headCommit ?? "", currentWorkspace.head],
                            author: authorIdentity,
                            timestamp,
                            timezone: COMMIT_TIMEZONE,
                            message
                        });

                        await tx.commit.create({
                            data: {
                                commitHash: newMergeCommitHash,
                                rootTree: finalRootTreeHash,
                                parent: currentRepo.headCommit,
                                author: `${authorIdentity.name} <${authorIdentity.email}>`,
                                timestamp: committedAt,
                                message,
                                parentWorkspaceId: null
                            }
                        });

                        await tx.commitParent.createMany({
                            data: [
                                { commitHash: newMergeCommitHash, parentHash: currentRepo.headCommit ?? "", ordinal: 0 },
                                { commitHash: newMergeCommitHash, parentHash: currentWorkspace.head, ordinal: 1 }
                            ]
                        });

                        const repoUpdate = await tx.repository.updateMany({
                            where: { id: repoId, headCommit: currentRepo.headCommit },
                            data: { headCommit: newMergeCommitHash }
                        });
                        if (repoUpdate.count === 0) {
                            throw new BadRequestError("Concurrent modification: Repository HEAD advanced. Please retry.");
                        }

                        await tx.pullRequest.update({
                            where: { id: prId },
                            data: {
                                status: "MERGED",
                                baseCommit: mergeResult.baseCommit,
                                mergeCommit: newMergeCommitHash,
                                updatedAt: new Date()
                            }
                        });

                        await tx.workspace.update({
                            where: { id: pr.workspaceId! },
                            data: {
                                status: "CLEAN",
                                head: newMergeCommitHash,
                                updatedAt: new Date()
                            }
                        });

                        return {
                            status: "MERGED",
                            mergeCommitHash: newMergeCommitHash
                        };
                    }
                }
            });

            if (result.status === "GIT_HISTORY_CHANGED") {
                throw new BadRequestError("Git history has changed. Please update the given conflicts.");
            }

            if (result.status === "UNRESOLVED_CONFLICTS") {
                throw new BadRequestError(`Cannot merge: there are still ${result.pendingCount} unresolved conflicts.`);
            }

            if (result.status === "CONFLICTS_DETECTED") {
                throw new BadRequestError("Conflicts detected. Please resolve conflicts before merging.");
            }

            try {
                await notificationService.notify({
                    userId: pr.authorId,
                    actorId: userId,
                    type: "pr_merged",
                    context: {
                        actorName: req.user!.name,
                        repoName: pr.repo.name,
                        prTitle: pr.title
                    },
                    data: {
                        repoId,
                        prId: pr.id,
                        mergeCommit: result.mergeCommitHash!
                    }
                });
            } catch (notifyErr) {
                // swallow
            }

            res.status(200).json({
                status: "success",
                message: "Pull request merged successfully.",
                data: {
                    mergeCommit: result.mergeCommitHash
                }
            });

        } catch (err) {
            handleError("/api/pr/merge/:repoId/:prId", err, next);
        }
    }

    static async checkPrMergeability(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = prMergeabilitySchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId, prId } = parsed.data;

            // 1. Fetch Pull Request and validate it exists and is OPEN
            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId, workspaceId },
                include: {
                    repo: true,
                    workspace: true
                }
            });
            if (!pr) throw new NotFoundError("Pull Request not found");
            if (pr.status !== "OPEN") {
                res.status(200).json({
                    status: "success",
                    data: {
                        canMerge: false,
                        conflictCount: 0,
                        totalConflictCount: 0,
                        hasMergeState: false,
                        prStatus: pr.status,
                        isMerged: pr.status === "MERGED"
                    }
                });
                return;
            }

            // 2. Look for any active or resolved MergeState associated with this PR
            const mergeState = await db.prisma.mergeState.findFirst({
                where: { prId, status: { in: ["IN_PROGRESS", "RESOLVED"] } }
            });

            if (!mergeState) {
                // No active MergeState means no conflicts exist / it is clean to merge
                res.status(200).json({
                    status: "success",
                    data: {
                        canMerge: true,
                        conflictCount: 0,
                        totalConflictCount: 0,
                        hasMergeState: false,
                        isMerged: false
                    }
                });
                return;
            }

            if (mergeState.oursCommit !== pr.repo.headCommit || mergeState.theirsCommit !== pr.workspace?.head) {
                const newOursCommit = pr.repo.headCommit;
                const newTheirsCommit = pr.workspace?.head;
                if (newOursCommit && newTheirsCommit) {
                    await db.prisma.$transaction(async (tx) => {
                        await PRController.reEvaluateConflictsHelper(
                            tx,
                            pr,
                            mergeState,
                            newOursCommit,
                            newTheirsCommit
                        );
                    });
                }
            }

            // 3. Count any merge conflicts that are not resolved (still PENDING)
            const pendingCount = await db.prisma.mergeConflict.count({
                where: {
                    mergeStateId: mergeState.id,
                    resolution: "PENDING"
                }
            });

            const totalCount = await db.prisma.mergeConflict.count({
                where: {
                    mergeStateId: mergeState.id
                }
            });

            res.status(200).json({
                status: "success",
                data: {
                    canMerge: pendingCount === 0,
                    conflictCount: pendingCount,
                    totalConflictCount: totalCount,
                    hasMergeState: true,
                    isMerged: false
                }
            });

        } catch (err) {
            handleError("/api/pr/mergeability/:repoId/:workspaceId/:prId", err, next);
        }
    }

    static async fetchAssignedReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsedParams = listAssignedReviewsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedQuery = listAssignedReviewsQuerySchema.safeParse(req.query);
            if (!parsedQuery.success) throw new BadRequestError(parsedQuery.error.issues[0].message);

            const { repoId } = parsedParams.data;
            const { verdict, cursor, limit, q } = parsedQuery.data;

            const reviewFilter: any = {
                reviewerId: userId,
                pr: {
                    repoId: repoId
                }
            };
            if (verdict) {
                reviewFilter.verdict = verdict;
            }
            if (q) {
                reviewFilter.pr = {
                    ...reviewFilter.pr,
                    OR: [
                        { title: { contains: q, mode: "insensitive" } },
                        { description: { contains: q, mode: "insensitive" } }
                    ]
                };
            }

            const reviews = await db.prisma.prReview.findMany({
                where: reviewFilter,
                orderBy: [
                    { createdAt: "desc" },
                    { id: "desc" }
                ],
                take: limit + 1,
                ...(cursor && { cursor: { id: cursor }, skip: 1 }),
                include: {
                    pr: {
                        include: {
                            author: {
                                select: {
                                    id: true,
                                    displayName: true,
                                    email: true
                                }
                            }
                        }
                    }
                }
            });

            const hasMore = reviews.length > limit;
            const activeReviews = hasMore ? reviews.slice(0, limit) : reviews;
            const nextCursor = hasMore ? activeReviews[activeReviews.length - 1].id : null;

            const pullRequests = activeReviews.map(r => ({
                ...r.pr,
                reviewId: r.id,
                reviewVerdict: r.verdict,
                reviewCreatedAt: r.createdAt
            }));

            res.status(200).json({
                status: "success",
                data: pullRequests,
                pagination: {
                    nextCursor,
                    hasMore
                }
            });

        } catch (err) {
            handleError("/api/pr/assigned-reviews/:repoId", err, next);
        }
    }

    static async getReviewerViewData(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const parsed = reviewerPrViewSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId, prId } = parsed.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId, workspaceId }
            });
            if (!pr) throw new NotFoundError("Pull Request not found");

            // Members can only view their own PRs.
            if (membership === "member") {
                const workspace = await db.prisma.workspace.findUnique({
                    where: { id: workspaceId },
                    select: { userId: true }
                });
                if (!workspace || req.user.sub !== workspace.userId) {
                    throw new UnauthorizedError("This PR does not belong to you");
                }
            }

            // 1. Get all changes for this PR using the helper
            const allChanges = await PRController.getPrChangesHelper(repoId, workspaceId);

            // 2. Fetch the active or resolved MergeState and its conflicts
            const mergeState = await db.prisma.mergeState.findFirst({
                where: {
                    prId,
                    status: { in: ["IN_PROGRESS", "RESOLVED"] }
                },
                include: {
                    conflicts: true
                }
            });

            // 3. Separate files into conflicted vs normal
            const conflictedPaths = new Set(mergeState?.conflicts.map(c => c.filePath) ?? []);

            const conflicts = mergeState ? mergeState.conflicts.map(conflict => ({
                filePath: conflict.filePath,
                conflictType: conflict.conflictType,
                baseBlob: conflict.baseBlob,
                oursBlob: conflict.oursBlob,
                theirsBlob: conflict.theirsBlob,
                resolvedBlob: conflict.resolvedBlob,
                resolution: conflict.resolution,
                resolvedAt: conflict.resolvedAt
            })) : [];

            const normalChanges = allChanges.filter(c => !conflictedPaths.has(c.path));

            res.status(200).json({
                status: "success",
                data: {
                    conflicts,
                    normalChanges
                }
            });

        } catch (err) {
            handleError("/api/pr/review-view/:repoId/:workspaceId/:prId", err, next);
        }
    }

    static async getChangesWithConflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const membership = req.membership?.role;
            if (!membership) throw new UnauthorizedError("Not enough permission");

            const parsed = reviewerPrViewSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceId, prId } = parsed.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId, workspaceId }
            });
            if (!pr) throw new NotFoundError("Pull Request not found");

            if (membership === "member") {
                const workspace = await db.prisma.workspace.findUnique({
                    where: { id: workspaceId },
                    select: { userId: true }
                });
                if (!workspace || req.user.sub !== workspace.userId) {
                    throw new UnauthorizedError("This PR does not belong to you");
                }
            }

            let mergeState = await db.prisma.mergeState.findFirst({
                where: {
                    prId,
                    status: { in: ["IN_PROGRESS", "RESOLVED"] }
                }
            });

            const currentWorkspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { head: true }
            });
            const currentRepo = await db.prisma.repository.findUnique({
                where: { id: repoId },
                select: { headCommit: true }
            });

            if (!currentWorkspace || !currentRepo) {
                throw new NotFoundError("Workspace or Repository not found");
            }

            if (mergeState) {
                const isUpToDate = (currentWorkspace.head === mergeState.theirsCommit) &&
                    (currentRepo.headCommit === mergeState.oursCommit);

                if (!isUpToDate) {
                    const newOursCommit = currentRepo.headCommit;
                    const newTheirsCommit = currentWorkspace.head;
                    if (newOursCommit && newTheirsCommit) {
                        await db.prisma.$transaction(async (tx) => {
                            await PRController.reEvaluateConflictsHelper(
                                tx,
                                pr,
                                mergeState,
                                newOursCommit,
                                newTheirsCommit
                            );
                        });
                    }
                }
            }

            const dbConflicts = mergeState
                ? await db.prisma.mergeConflict.findMany({
                    where: { mergeStateId: mergeState.id }
                })
                : [];

            const repoHead = currentRepo.headCommit;
            const workspaceHead = currentWorkspace.head;

            if (!workspaceHead) {
                throw new BadRequestError("Workspace has no head commit");
            }

            const baseCommitTrail = await storageService.mergeBase(repoHead, workspaceHead);
            const baseCommitHash = baseCommitTrail.length > 0 ? baseCommitTrail[0] : null;

            const [baseCommitRecord, prCommitRecord] = await Promise.all([
                baseCommitHash ? db.prisma.commit.findUnique({ where: { commitHash: baseCommitHash }, select: { rootTree: true } }) : null,
                db.prisma.commit.findUnique({ where: { commitHash: workspaceHead }, select: { rootTree: true } })
            ]);

            if (!prCommitRecord) {
                throw new NotFoundError("Workspace head commit not found");
            }

            const diffEntries = await storageService.getTreeDiff(
                baseCommitRecord?.rootTree ?? null,
                prCommitRecord.rootTree
            );

            const conflictMap = new Map<string, any>(dbConflicts.map(c => [c.filePath, c]));

            const files = diffEntries
                .filter(d => d.type === "blob")
                .map(d => {
                    const conflict = conflictMap.get(d.path);
                    if (conflict) {
                        return {
                            path: d.path,
                            type: d.type,
                            changeType: d.changeType,
                            isConflicted: true,
                            conflictInfo: {
                                conflictId: conflict.id,
                                oursBlob: conflict.oursBlob,
                                theirsBlob: conflict.theirsBlob,
                                baseBlob: conflict.baseBlob,
                                resolvedBlob: conflict.resolvedBlob,
                                resolution: conflict.resolution,
                                conflictType: conflict.conflictType
                            },
                            oldObjectHash: null,
                            newObjectHash: null
                        };
                    } else {
                        return {
                            path: d.path,
                            type: d.type,
                            changeType: d.changeType,
                            isConflicted: false,
                            conflictInfo: null,
                            oldObjectHash: d.oldObjectHash ?? null,
                            newObjectHash: d.newObjectHash ?? null
                        };
                    }
                });

            res.status(200).json({
                status: "success",
                data: {
                    files
                }
            });

        } catch (err) {
            handleError("/api/pr/changes-view/:repoId/:workspaceId/:prId", err, next);
        }
    }

    static async addReviewers(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsedParams = prDetailsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedBody = addReviewersSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);

            const { repoId, prId } = parsedParams.data;
            const { reviewerIds } = parsedBody.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId },
                include: {
                    repo: {
                        select: { name: true }
                    }
                }
            });
            if (!pr) throw new NotFoundError("Pull Request not found");
            if (pr.status !== "OPEN") throw new BadRequestError("Cannot add reviewers to a closed/merged PR");

            const validReviewerUsers = await PRController.validateReviewersHelper(repoId, reviewerIds, userId);

            const existingReviews = await db.prisma.prReview.findMany({
                where: { prId, reviewerId: { in: validReviewerUsers.map(u => u.id) } }
            });
            const existingReviewerIds = new Set(existingReviews.map(r => r.reviewerId));

            const newReviewers = validReviewerUsers.filter(u => !existingReviewerIds.has(u.id));

            if (newReviewers.length > 0) {
                await db.prisma.prReview.createMany({
                    data: newReviewers.map(u => ({
                        prId,
                        reviewerId: u.id,
                        verdict: "PENDING"
                    }))
                });

                const actorName = (await db.prisma.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName || "Someone";
                for (const reviewer of newReviewers) {
                    try {
                        await notificationService.notify({
                            userId: reviewer.id,
                            actorId: userId,
                            type: "pr_created",
                            context: {
                                actorName,
                                repoName: pr.repo.name,
                                prTitle: pr.title
                            },
                            data: {
                                repoId,
                                prId
                            }
                        });
                    } catch (notifyErr) {
                        // Swallow notification errors
                    }
                }
            }

            res.status(200).json({
                status: "success",
                message: "Reviewers added successfully.",
                data: {
                    addedReviewerCount: newReviewers.length
                }
            });

        } catch (err) {
            handleError("/api/pr/add-reviewers/:repoId/:prId", err, next);
        }
    }

    static async getPrReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = prDetailsSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, prId } = parsed.data;

            const reviews = await db.prisma.prReview.findMany({
                where: {
                    prId,
                    pr: { repoId }
                },
                include: {
                    reviewer: {
                        select: {
                            id: true,
                            displayName: true,
                            email: true,
                            avatarUrl: true,
                            username: true
                        }
                    }
                },
                orderBy: {
                    createdAt: "asc"
                }
            });

            res.status(200).json({
                status: "success",
                data: reviews
            });

        } catch (err) {
            handleError("/api/pr/reviews/:repoId/:prId", err, next);
        }
    }

    static async submitReview(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");
            const userId = req.user.sub;

            const parsedParams = prDetailsSchema.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedBody = submitReviewSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);

            const { repoId, prId } = parsedParams.data;
            const { verdict, body } = parsedBody.data;

            const pr = await db.prisma.pullRequest.findFirst({
                where: { id: prId, repoId },
                include: {
                    repo: {
                        select: { name: true }
                    }
                }
            });
            if (!pr) throw new NotFoundError("Pull Request not found");
            if (pr.status !== "OPEN") throw new BadRequestError("Cannot submit a review for a closed or merged PR");

            const review = await db.prisma.prReview.findFirst({
                where: { prId, reviewerId: userId }
            });
            if (!review) {
                throw new ForbiddenError("You are not assigned as a reviewer on this Pull Request.");
            }

            const updatedReview = await db.prisma.prReview.update({
                where: { id: review.id },
                data: {
                    verdict: verdict as any, // Cast to any or ReviewVerdict enum type safely
                    body: body || null,
                    createdAt: new Date()
                }
            });

            // Notify PR author about this review
            try {
                const actorName = (await db.prisma.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName || "Someone";
                await notificationService.notify({
                    userId: pr.authorId,
                    actorId: userId,
                    type: "pr_reviewed",
                    context: {
                        actorName,
                        repoName: pr.repo.name,
                        prTitle: pr.title
                    },
                    data: {
                        repoId,
                        prId,
                        reviewId: updatedReview.id,
                        verdict: updatedReview.verdict
                    }
                });
            } catch (notifyErr) {
                // Swallow notification errors
            }

            res.status(200).json({
                status: "success",
                message: "PR review submitted successfully.",
                data: updatedReview
            });

        } catch (err) {
            handleError("/api/pr/submit-review/:repoId/:prId", err, next);
        }
    }

    static async getPrReviewStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login");

            const parsed = prReviewStatusSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, prId } = parsed.data;
            const reviewerId = req.user.sub;

            const review = await db.prisma.prReview.findFirst({
                where: {
                    prId,
                    reviewerId,
                    pr: { repoId }
                },
                select: {
                    id: true,
                    verdict: true,
                    body: true,
                    createdAt: true
                }
            });

            if (!review) throw new NotFoundError("Review record not found for this reviewer and PR.");

            res.status(200).json({
                status: "success",
                data: review
            });

        } catch (err) {
            handleError("/api/pr/review-status/:repoId/:prId", err, next);
        }
    }
}