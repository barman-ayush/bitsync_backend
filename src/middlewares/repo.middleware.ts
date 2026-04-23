import { NextFunction, Request, Response } from "express";
import { NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { handleError } from "./error.middleware";
import { RepoRole } from "./permission.middleware";


export async function repoContext(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        if (!req.user) throw new UnauthorizedError("Not authenticated");

        const { repoId } = req.params;
        if (!repoId) throw new NotFoundError("Repository not found");

        const repo = await db.prisma.repository.findFirst({
            where: { id: repoId as string, isDeleted: false },
        });
        if (!repo) throw new NotFoundError("Repository not found");

        const membership = await db.prisma.repoMember.findFirst({
            where: { id: repoId as string, userId: req.user.sub, deletedAt: null },
            select: { role: true },
        });
        if (!membership) throw new NotFoundError("Repository not found");

        req.repo = repo;
        req.membership = { role: membership.role as RepoRole };
        next();
    } catch (err) {
        handleError("repo_context_middleware", err, next);
    }
}
