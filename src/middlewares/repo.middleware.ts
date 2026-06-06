import { NextFunction, Request, Response } from "express";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import db from "../services/database.service";
import { handleError } from "./error.middleware";
import { RepoRole } from "./permission.middleware";
import { repoContextSchema, repositoryId } from "../validators/repo.validator";


// resolveRepoBySlug : TIER-1 context for the page mount (/:username/:reponame).
// Resolves slug -> repo via the owner join (the only join in the repo path) and
// loads full metadata + the caller's role. Runs ONCE per page visit; subsequent
// tab/data calls key off repoId via requireRepoAccess instead.
export async function resolveRepoBySlug(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        if (!req.user) throw new UnauthorizedError("Not authenticated");

        const parsedData = repoContextSchema.safeParse(req.params);
        if (!parsedData.success) throw new BadRequestError(parsedData.error.issues[0].message);

        const { reponame, username } = parsedData.data;

        const repo = await db.prisma.repository.findFirst({
            where: {
                nameNormalized: reponame.toLowerCase(),
                isDeleted: false,
                owner: { usernameNormalized: username.toLowerCase() },
            },
            select: {
                id: true,
                name: true,
                description: true,
                ownerId: true,
                headCommit: true,
                isDeleted: true,
                createdAt: true,
                updatedAt: true,
                members: {
                    where: { userId: req.user.sub, deletedAt: null },
                    select: { role: true },
                    take: 1,
                },
            },
        });

        if (!repo || repo.members.length === 0) {
            throw new NotFoundError("Repository not found");
        }

        const { members, ...repoData } = repo;
        req.repo = repoData;
        req.repoId = repoData.id;
        req.membership = { role: members[0].role as RepoRole };
        next();
    } catch (err) {
        handleError("resolve_repo_by_slug", err, next);
    }
}

// requireRepoAccess : TIER-2 context for tab/data endpoints (/:repoId/...).
// A single point-read on the @@unique([repoId, userId]) index — no owner join,
// no metadata. Re-verifies the caller still has access (membership can be revoked
// mid-session) and loads only the role for authorize() to check in-memory.
export async function requireRepoAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        if (!req.user) throw new UnauthorizedError("Not authenticated");

        const parsed = repositoryId.safeParse(req.params);
        if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

        const { repoId } = parsed.data;

        const member = await db.prisma.repoMember.findUnique({
            where: { repoId_userId: { repoId, userId: req.user.sub } },
            // repo.isDeleted rides along on the PK join — membership rows
            // survive a repo soft-delete, so the row alone isn't proof the
            // repo is still alive.
            select: { role: true, deletedAt: true, repo: { select: { isDeleted: true } } },
        });

        if (!member || member.deletedAt || member.repo.isDeleted) {
            throw new NotFoundError("Repository not found");
        }

        req.repoId = repoId;
        req.membership = { role: member.role as RepoRole };
        next();
    } catch (err) {
        handleError("require_repo_access", err, next);
    }
}
