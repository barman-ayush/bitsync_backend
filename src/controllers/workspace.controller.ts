import { NextFunction, Request, Response } from "express";
import { handleError } from "../middlewares/error.middleware";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/app.error";
import { workspaceSchema, listWorkspaceQuerySchema, checkWorkspaceNameSchema, workspaceTreeParamsSchema, workspaceTreeQuerySchema, uploadChangesSchema, blobDownloadParamsSchema } from "../validators/workspace.validators";
import db from "../services/database.service";
import storageService from "../services/storage.service";
import cloudinaryService from "../services/cloudinary.service";
import { repositoryId } from "../validators/repo.validator";
import { hashBlobContent } from "../utils/blob.utils";

// Cap on a single uploaded blob (raw file content). Keeps one request from
// buffering an unbounded payload into memory; the FE should reject larger files
// client-side before attempting an upload.
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

export class WorkspaceController {
    static async createWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const parsed = workspaceSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, name } = parsed.data

            const repository = await db.prisma.repository.findUnique({ where: { id: repoId } });

            if (!repository || repository?.isDeleted) throw new NotFoundError("No such repository found");

            const workspaceData = await db.prisma.workspace.create({
                data: {
                    repoId,
                    userId: req.user.sub,
                    name,
                    forkPoint: repository.headCommit,
                    head: repository.headCommit,
                }
            });

            res.status(200).json({
                status: "success",
                data: workspaceData,
            });
        } catch (err) {
            handleError("/api/workspace/create/:repoId/:name", err, next);
        }
    }

    static async loadAllWorkspaces(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please Login to continue");

            const parsedParams = repositoryId.safeParse(req.params);
            if (!parsedParams.success) throw new BadRequestError(parsedParams.error.issues[0].message);

            const parsedQuery = listWorkspaceQuerySchema.safeParse(req.query);
            if (!parsedQuery.success) throw new BadRequestError(parsedQuery.error.issues[0].message);

            const { repoId } = parsedParams.data;
            const { cursor, limit } = parsedQuery.data;

            // Fetch one extra row to detect whether another page exists without a
            // separate count query. (updatedAt, id) gives a stable total order so
            // the cursor never skips or repeats rows when workspaces change.
            const rows = await db.prisma.workspace.findMany({
                where: { userId: req.user.sub, repoId },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: limit + 1,
                ...(cursor && { cursor: { id: cursor }, skip: 1 }),
            });

            const hasMore = rows.length > limit;
            const workspaces = hasMore ? rows.slice(0, limit) : rows;
            const nextCursor = hasMore ? workspaces[workspaces.length - 1].id : null;

            res.status(200).json({
                status: "success",
                data: workspaces,
                pagination: { nextCursor, hasMore },
            });
        } catch (err) {
            handleError("/api/workspace/get-all/:repoId", err, next);
        }
    }


    static async checkWorkspaceName(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login");

            const parsed = checkWorkspaceNameSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { repoId, workspaceName } = parsed.data;

            // Scoped to the caller, matching create/list — workspace names are
            // unique per (repo, user), so another user's identical name is irrelevant.
            const existing = await db.prisma.workspace.findFirst({
                where: { repoId, userId: req.user.sub, name: workspaceName },
                select: { id: true },
            });

            res.status(200).json({
                status: "success",
                data: { available: !existing },
            });
        } catch (err) {
            handleError("/api/workspace/check/:repoId/:workspaceName", err, next);
        }
    }

    // getWorkspaceTree : one directory level of a workspace, committed entries
    // overlaid with uncommitted changes (spec 03_commit §1.4). Repo membership +
    // view permission are enforced by middleware; this also asserts the workspace
    // belongs to this repo AND to the caller (workspaces are private per user).
    static async getWorkspaceTree(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const params = workspaceTreeParamsSchema.safeParse(req.params);
            if (!params.success) throw new BadRequestError(params.error.issues[0].message);

            const query = workspaceTreeQuerySchema.safeParse(req.query);
            if (!query.success) throw new BadRequestError(query.error.issues[0].message);

            const { repoId, workspaceId } = params.data;
            const { path, tree_hash } = query.data;

            const workspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { repoId: true, userId: true, head: true },
            });
            if (!workspace || workspace.repoId !== repoId || workspace.userId !== req.user.sub) {
                throw new NotFoundError("Workspace not found");
            }

            // Which committed tree backs this level:
            //  - explicit tree_hash    -> navigating into a committed subfolder
            //  - none + root (path "")  -> derive the root tree from the workspace head
            //  - none + nested path     -> a newly-added folder, no committed tree
            let treeHash: string | null;
            if (tree_hash !== undefined) {
                treeHash = tree_hash;
            } else if (path === "") {
                // workspace.head is null -> Workspace created on a empty repository
                const headCommit = workspace.head
                    ? await db.prisma.commit.findUnique({
                          where: { commitHash: workspace.head },
                          select: { rootTree: true },
                      })
                    : null;
                treeHash = headCommit?.rootTree ?? null;
            } else {
                // No tree hash but path exists -> uncomitted folder
                treeHash = null;
            }

            const data = await storageService.resolveWorkspaceTree(workspaceId, treeHash, path);

            res.status(200).json({
                status: "success",
                data,
            });
        } catch (err) {
            handleError("/api/workspace/tree/:repoId/:workspaceId", err, next);
        }
    }


    // uploadBlob : store raw file content as a content-addressed blob and return
    // its hash. The body is the raw bytes (Content-Type: application/octet-stream),
    // parsed by an express.raw() middleware on this route. Content is pushed to
    // Cloudinary (authenticated raw resource, public_id == hash) and only the
    // metadata row is kept in the DB. Blobs are global and immutable — identical
    // content dedups to one row — so this is idempotent and keyed by the computed
    // hash. The client uploads content here first, then registers the resulting
    // hash via uploadWorkspaceChanges, and later reads it back via getBlob.
    static async uploadBlob(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const parsed = repositoryId.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            // express.raw() yields a Buffer; anything else means the client sent
            // the wrong Content-Type and the raw parser never ran.
            const content = req.body;
            if (!Buffer.isBuffer(content)) {
                throw new BadRequestError("Body must be raw bytes (Content-Type: application/octet-stream).");
            }
            if (content.length > MAX_BLOB_BYTES) {
                throw new BadRequestError(`File exceeds the ${MAX_BLOB_BYTES} byte upload limit.`);
            }

            const blobHash = hashBlobContent(content);

            // Dedup: only store when this exact content is new. Same hash ⇒ same
            // bytes (content-addressed), so an existing row needs no update.
            const existing = await db.prisma.blob.findUnique({
                where: { blobHash },
                select: { blobHash: true },
            });
            if (!existing) {
                // Push bytes to Cloudinary first; only record the row once the
                // content is safely stored, so a blob row never points at missing content.
                await cloudinaryService.uploadRawBlob(content, blobHash);
                await db.prisma.blob.create({
                    data: { blobHash, size: BigInt(content.length) },
                });
            }

            res.status(existing ? 200 : 201).json({
                status: "success",
                data: { blobHash, size: content.length, deduped: !!existing },
            });
        } catch (err) {
            handleError("/api/workspace/blob/:repoId", err, next);
        }
    }

    // getBlob : mint a short-lived signed URL the FE uses to download a blob's raw
    // content from Cloudinary. Content is stored under "authenticated" delivery, so
    // it is never publicly reachable — access is gated here by repo membership +
    // view permission (middleware), then a signed URL is generated per request.
    // Blobs are global/content-addressed, so this is keyed by hash, not by repo;
    // the unguessable 64-char hash is itself the capability to read the content.
    static async getBlob(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const parsed = blobDownloadParamsSchema.safeParse(req.params);
            if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);

            const { blobHash } = parsed.data;

            const blob = await db.prisma.blob.findUnique({
                where: { blobHash },
                select: { blobHash: true, size: true },
            });
            if (!blob) throw new NotFoundError("Blob not found");

            const { url, expiresAt } = cloudinaryService.getSignedUrl(blobHash);

            res.status(200).json({
                status: "success",
                data: { blobHash, size: Number(blob.size), url, expiresAt },
            });
        } catch (err) {
            handleError("/api/workspace/blob/:repoId/:blobHash", err, next);
        }
    }

    // uploadWorkspaceChanges : batch upsert of uncommitted changes into
    // workspace_changes (the dirty working dir — no staging area). The client
    // sends only (filePath, blobHash); the server derives the ChangeAction by
    // comparing each path against the workspace HEAD tree:
    //   blobHash null  + path in HEAD      -> DELETE
    //   blobHash null  + path not in HEAD  -> no-op (drop any pending row)
    //   blobHash set   + path not in HEAD  -> ADD
    //   blobHash == HEAD blob              -> no-op / revert (drop any pending row)
    //   blobHash set   + differs from HEAD -> MODIFY
    // Workspaces are private per user, so ownership is asserted here even though
    // repo membership is already checked by middleware.
    static async uploadWorkspaceChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new UnauthorizedError("Please login to continue");

            const params = workspaceTreeParamsSchema.safeParse(req.params);
            if (!params.success) throw new BadRequestError(params.error.issues[0].message);

            const body = uploadChangesSchema.safeParse(req.body);
            if (!body.success) throw new BadRequestError(body.error.issues[0].message);

            const { repoId, workspaceId } = params.data;
            const { changes } = body.data;

            const workspace = await db.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { repoId: true, userId: true, head: true },
            });
            if (!workspace || workspace.repoId !== repoId || workspace.userId !== req.user.sub) {
                throw new NotFoundError("Workspace not found");
            }

            // HEAD root tree backing this workspace (null on an empty-repo workspace
            // with no commits yet — every path then resolves as ADD).
            const headRootTree = workspace.head
                ? (
                      await db.prisma.commit.findUnique({
                          where: { commitHash: workspace.head },
                          select: { rootTree: true },
                      })
                  )?.rootTree ?? null
                : null;

            // Every ADD/MODIFY must reference an already-uploaded blob (01_storage
            // §3.6) — reject the whole batch if any is missing, before writing.
            const referenced = [...new Set(changes.filter((c) => c.blobHash).map((c) => c.blobHash as string))];
            if (referenced.length > 0) {
                const found = await db.prisma.blob.findMany({
                    where: { blobHash: { in: referenced } },
                    select: { blobHash: true },
                });
                const foundSet = new Set(found.map((b) => b.blobHash));
                const missing = referenced.filter((h) => !foundSet.has(h));
                if (missing.length > 0) {
                    throw new BadRequestError(
                        `Unknown blob hash(es): ${missing.join(", ")}. Upload the content first.Rejecting the whole batch`,
                    );
                }
            }

            // Classify each change against HEAD. Real changes are upserted;
            // no-ops (reverts, deletes of never-committed files) drop any pending row.
            const upserts: { filePath: string; action: "ADD" | "MODIFY" | "DELETE"; blobHash: string | null }[] = [];
            const drops: string[] = [];
            const summary = { added: 0, modified: 0, deleted: 0, noop: 0 };

            for (const change of changes) {
                const headBlob = await storageService.lookupBlobAtPath(headRootTree, change.filePath);

                if (change.blobHash === null) {
                    if (headBlob) {
                        upserts.push({ filePath: change.filePath, action: "DELETE", blobHash: null });
                        summary.deleted++;
                    } else {
                        // Deleting a file that was never committed: nothing to record.
                        drops.push(change.filePath);
                        summary.noop++;
                    }
                } else if (!headBlob) {
                    upserts.push({ filePath: change.filePath, action: "ADD", blobHash: change.blobHash });
                    summary.added++;
                } else if (headBlob === change.blobHash) {
                    // Content identical to HEAD: the user reverted — clear any pending change.
                    drops.push(change.filePath);
                    summary.noop++;
                } else {
                    upserts.push({ filePath: change.filePath, action: "MODIFY", blobHash: change.blobHash });
                    summary.modified++;
                }
            }

            // Apply atomically so a partial batch never lands.
            await db.prisma.$transaction([
                ...drops.map((filePath) =>
                    db.prisma.workspaceChange.deleteMany({ where: { workspaceId, filePath } }),
                ),
                ...upserts.map((u) =>
                    db.prisma.workspaceChange.upsert({
                        where: { workspaceId_filePath: { workspaceId, filePath: u.filePath } },
                        create: { workspaceId, filePath: u.filePath, action: u.action, blobHash: u.blobHash },
                        update: { action: u.action, blobHash: u.blobHash },
                    }),
                ),
            ]);

            res.status(200).json({
                status: "success",
                data: { summary },
            });
        } catch (err) {
            handleError("/api/workspace/tree/upload/:repoId/:workspaceId", err, next);
        }
    }

}