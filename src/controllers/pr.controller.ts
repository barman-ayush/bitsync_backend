import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { createPullRequestSchema, prSchema, listPrQuerySchema } from "../validators/pr.validators";
import db from "../services/database.service";
import storageService from "../services/storage.service";
import { repositoryId } from "../validators/repo.validator";


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


            const workspaceCommitTrail: string[] = await storageService.mergeBase(repoHead.headCommit, workspaceHead.head);

            if (workspaceCommitTrail.length == 0) throw new BadRequestError("No commit trail found !");

            const commitDetails = await db.prisma.commit.findMany({
                where: {

                    commitHash: {
                        in: workspaceCommitTrail
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

            const parsed = prSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const parsedBody = createPullRequestSchema.safeParse(req.body);
            if (!parsedBody.success) throw new BadRequestError(parsedBody.error.issues[0].message);


            const { repoId, workspaceId } = parsed.data;
            const { title, description } = parsedBody.data;

            const repositoryActive = await db.prisma.repository.findUnique({
                where: { id: repoId, isDeleted: false }
            });

            if (!repositoryActive) throw new NotFoundError("No active repository found")


            const workspaceExists = await db.prisma.workspace.findUnique({
                where: { repoId, id: workspaceId, userId: req.user.sub },
            });
            if (!workspaceExists) throw new NotFoundError("No such Workspace found");
            if (!workspaceExists.head) throw new BadRequestError("Cannot create PR for a empty workspace");

            if (workspaceExists.repoId != repoId || workspaceExists.userId != req.user.sub) throw new BadRequestError("Invalid workspace");

            if (repositoryActive.headCommit) {
                const commitTrail = await storageService.mergeBase(repositoryActive.headCommit, workspaceExists.head);
                if (commitTrail[0] == workspaceExists.head) throw new BadRequestError("Cannot create PR for empty workspace, need at least one commit.");
            }
            const isActivePR = await db.prisma.pullRequest.findFirst({
                where: { repoId, workspaceId, status: "OPEN" }
            });
            if (isActivePR) throw new BadRequestError("Active PR already exists for this workspace");

            const pendingChanges = await db.prisma.workspaceChange.findFirst({ where: { workspaceId: workspaceExists.id } });
            if (pendingChanges) throw new BadRequestError("Pending changes found in workspace, please commit them before creating a PR");
            const prCreated = await db.prisma.pullRequest.create({
                data: {
                    repoId: repoId,
                    workspaceId: workspaceId,
                    title: title,
                    description: description,
                    authorId: req.user.sub,
                    prHead: workspaceExists.head!,
                    status: "OPEN",
                    createdAt: new Date(),
                }
            });

            // #TODO - Notify owners, admins

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
                where: { repoId, workspaceId, status: "OPEN" }
            });

            let status = "CREATE_PR";

            if (isActivePR) {
                if (isActivePR.prHead === workspace.head) status = "IN_SYNC";
                else status = "PENDING_SYNC";
            }

            res.status(200).json({
                status: "success",
                data: status
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

}