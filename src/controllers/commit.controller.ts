import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { workspaceTreeParamsSchema, createCommitSchema, listCommitHistoryQuerySchema } from "../validators/workspace.validators";
import db from "../services/database.service";
import storageService from "../services/storage.service";

export class CommitController {
    static async createCommit(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const params = workspaceTreeParamsSchema.safeParse(req.params);
            if (!params.success) throw new BadRequestError(params.error.issues[0].message);

            const body = createCommitSchema.safeParse(req.body);
            if (!body.success) throw new BadRequestError(body.error.issues[0].message);

            const { repoId, workspaceId } = params.data;
            const { message } = body.data;

            const workspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { repoId: true, userId: true, status: true },
            });
            if (!workspace || workspace.repoId !== repoId || workspace.userId !== req.user.sub) {
                throw new NotFoundError("Workspace not found");
            }
            if (workspace.status === "CONFLICTED") {
                throw new BadRequestError("Cannot commit: please resolve conflicts first.");
            }

            const commit = await db.prisma.$transaction(async (tx) => {
                const input = {
                    workspaceId,
                    author: { name: req.user!.name, email: req.user!.email },
                    message,
                };
                const commit = await storageService.createCommit({ input, tx });
                const isPROpen = await tx.pullRequest.findFirst({
                    where: { workspaceId: workspaceId, status: "OPEN" }
                });
                if (isPROpen) {
                    await tx.pullRequest.update({
                        where: { id: isPROpen.id },
                        data: {
                            prHead: commit.commitHash,
                            updatedAt: new Date()
                        }
                    })
                }
                return commit;
            })


            res.status(201).json({
                status: "success",
                data: commit,
            });
        } catch (err) {
            handleError("/api/workspace/commit/:repoId/:workspaceId", err, next);
        }
    }

    static async getCommitHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const params = workspaceTreeParamsSchema.safeParse(req.params);
            if (!params.success) throw new BadRequestError(params.error.issues[0].message);

            const query = listCommitHistoryQuerySchema.safeParse(req.query);
            if (!query.success) throw new BadRequestError(query.error.issues[0].message);

            const { repoId, workspaceId } = params.data;
            const { cursor, limit } = query.data;

            const workspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { repoId: true, userId: true },
            });
            if (!workspace || workspace.repoId !== repoId || workspace.userId !== req.user.sub) {
                throw new NotFoundError("Workspace not found");
            }
            const rows = await db.prisma.commit.findMany({
                where: { parentWorkspaceId: workspaceId },
                orderBy: [{ timestamp: "desc" }, { commitHash: "desc" }],
                take: limit + 1,
                ...(cursor && { cursor: { commitHash: cursor }, skip: 1 }),
                select: {
                    commitHash: true,
                    parent: true,
                    rootTree: true,
                    author: true,
                    message: true,
                    timestamp: true,
                },
            });

            const hasMore = rows.length > limit;
            const commits = hasMore ? rows.slice(0, limit) : rows;
            const nextCursor = hasMore ? commits[commits.length - 1].commitHash : null;

            res.status(200).json({
                status: "success",
                data: commits,
                pagination: { nextCursor, hasMore },
            });
        } catch (err) {
            handleError("/api/commit/history/:repoId/:workspaceId", err, next);
        }
    }

}