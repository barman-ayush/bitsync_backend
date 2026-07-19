import { BadRequestError, ConflictError, InternalError, NotFoundError } from "../errors/app.error";
import { Prisma } from "../generated/prisma/client";
import { hashCommit, hashTrees } from "../utils/blob.utils";
import { BuildTreeChange, CommitIdentity, CreateCommitInput, CreateCommitResult, DiffEntry, MergeChangeClassification, MergeCheckResult, MergeConflictEntry, MergedPathEntry, ParentCommitRef, PathMap, ResolvedTree, TreeChild, TreeEntryType, WorkspaceTree, WorkspaceTreeEntry } from "../types/storage.types";
import db from "./database.service";

const MAX_DEPTH = 256;

// Timestamps stored in IST.
const COMMIT_TIMEZONE = "+0530";

// Counts path segments to determine directory depth.
const dirDepth = (dirPath: string): number => (dirPath.match(/\//g) ?? []).length;
class StorageService {
    private static instance: StorageService;

    private constructor() { };

    public static getInstance(): StorageService {
        if (!this.instance) this.instance = new StorageService();

        return this.instance;
    }

    // Fetches one directory level; batches blob size lookups to avoid N+1.
    public async resolveTrees(treeHash: string): Promise<ResolvedTree> {
        // Folders first, then files, each alphabetical.
        const entries = await db.prisma.treeEntry.findMany({
            where: { parentTree: treeHash },
            select: { name: true, entryType: true, objectHash: true },
            orderBy: [{ entryType: "desc" }, { name: "asc" }],
        });

        // Batch-fetch sizes for all blobs in one query.
        const blobHashes = [
            ...new Set(entries.filter((e) => e.entryType === "blob").map((e) => e.objectHash)),
        ];

        const sizeByHash = new Map<string, number>();
        if (blobHashes.length > 0) {
            const blobs = await db.prisma.blob.findMany({
                where: { blobHash: { in: blobHashes } },
                select: { blobHash: true, size: true },
            });
            // BigInt is not JSON-serialisable; coerce to Number.
            for (const b of blobs) sizeByHash.set(b.blobHash, Number(b.size));
        }

        return {
            treeHash,
            entries: entries.map((e) => ({
                name: e.name,
                type: e.entryType as TreeEntryType,
                objectHash: e.objectHash,
                ...(e.entryType === "blob" && { size: sizeByHash.get(e.objectHash) }),
            })),
        };
    }

    // Returns one directory level merged with uncommitted workspace changes,
    // tagging each entry with its status (ADDED/MODIFIED/DELETED/COMMITTED).
    public async resolveWorkspaceTree(
        workspaceId: string,
        treeHash: string | null,
        currentPath: string = "",
    ): Promise<WorkspaceTree> {
        // Committed entries for this level; empty if no commits yet.
        const committed = treeHash ? (await this.resolveTrees(treeHash)).entries : [];

        // Re-filter in JS to drop over-matched rows from the DB prefix query.
        const rawChanges = await db.prisma.workspaceChange.findMany({
            where: { workspaceId, filePath: { startsWith: currentPath } },
            select: { filePath: true, action: true, blobHash: true },
        });
        const changes = rawChanges.filter((c) => c.filePath.startsWith(currentPath));

        // Collapse changes to immediate children; deeper paths just mark their
        // top-level subfolder as a dirty subtree.
        type Immediate =
            | { kind: "file"; action: string; blobHash: string | null }
            | { kind: "subtree" };
        const immediate = new Map<string, Immediate>();
        for (const c of changes) {
            const relative = c.filePath.slice(currentPath.length);
            const slash = relative.indexOf("/");
            if (slash === -1) {
                // Direct file in this directory.
                immediate.set(relative, { kind: "file", action: c.action, blobHash: c.blobHash });
            } else {
                // Deeper file — flag its immediate parent as a dirty subtree.
                const subDirectory = relative.slice(0, slash) + "/";
                if (!immediate.has(subDirectory)) immediate.set(subDirectory, { kind: "subtree" });
            }
        }

        // Batch-fetch sizes for all changed blobs.
        const changeBlobHashes = [
            ...new Set(
                [...immediate.values()].flatMap((c) =>
                    c.kind === "file" && c.blobHash ? [c.blobHash] : [],
                ),
            ),
        ];
        const sizeByHash = new Map<string, number>();
        if (changeBlobHashes.length > 0) {
            const blobs = await db.prisma.blob.findMany({
                where: { blobHash: { in: changeBlobHashes } },
                select: { blobHash: true, size: true },
            });
            for (const b of blobs) sizeByHash.set(b.blobHash, Number(b.size));
        }

        const result: WorkspaceTreeEntry[] = [];

        // Overlay uncommitted changes onto committed entries.
        for (const entry of committed) {
            // Directory entry.
            if (entry.type === "tree") {
                const key = entry.name + "/";
                if (immediate.has(key)) {
                    immediate.delete(key);
                    result.push({ ...entry, status: "SUBTREE_MODIFIED" });
                } else {
                    result.push({ ...entry, status: "COMMITTED" });
                }
                continue;
            }

            // File entry.
            const change = immediate.get(entry.name);
            if (!change || change.kind !== "file") {
                // No uncommitted change for this file.
                result.push({ ...entry, status: "COMMITTED" });
                continue;
            }

            // File was modified or deleted in uncommitted changes.
            immediate.delete(entry.name);

            if (change.action === "DELETE") {
                result.push({ ...entry, status: "DELETED" });
            } else {
                // MODIFY (or ADD over an existing path): use new blob.
                result.push({
                    name: entry.name,
                    type: "blob",
                    objectHash: change.blobHash,
                    size: change.blobHash ? sizeByHash.get(change.blobHash) : undefined,
                    status: "MODIFIED",
                });
            }
        }

        // Remaining entries have no committed counterpart — newly added.
        for (const [name, change] of immediate) {
            if (change.kind === "subtree") {
                // New file under an uncommitted path → new folder.
                result.push({ name: name.slice(0, -1), type: "tree", objectHash: null, status: "ADDED" });
            } else if (change.action === "ADD" || change.action === "MODIFY") {
                // MODIFY with no committed entry is a data inconsistency; treat as ADD.
                result.push({
                    name,
                    type: "blob",
                    objectHash: change.blobHash,
                    size: change.blobHash ? sizeByHash.get(change.blobHash) : undefined,
                    status: "ADDED",
                });
            }
            // Leftover DELETE with no committed entry — nothing to show.
        }

        // Folders first, then files, each group alphabetical.
        result.sort((a, b) =>
            a.type !== b.type
                ? a.type < b.type ? 1 : -1
                : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );

        return { treeHash, entries: result };
    }

    // Walks a committed tree by path, returning the blob hash or null if not found.
    public async lookupBlobAtPath(
        rootTreeHash: string | null,
        filePath: string,
    ): Promise<string | null> {
        if (!rootTreeHash) return null;

        const segments = filePath.split("/");
        // Explicitly typed to break the inference cycle in the loop below.
        let currentTree: string = rootTreeHash;

        for (let i = 0; i < segments.length; i++) {
            const isLast = i === segments.length - 1;

            const entry: { entryType: string; objectHash: string } | null =
                await db.prisma.treeEntry.findUnique({
                    where: { parentTree_name: { parentTree: currentTree, name: segments[i] } },
                    select: { entryType: true, objectHash: true },
                });
            if (!entry) return null;

            if (isLast) {
                // Valid only if the final segment is a blob.
                return entry.entryType === "blob" ? entry.objectHash : null;
            }

            // Intermediate segments must be directories.
            if (entry.entryType !== "tree") return null;
            currentTree = entry.objectHash;
        }

        return null;
    }

    // Recursively walks a tree and returns a flat path → hash map.
    // Blobs are keyed by path ("src/main.py"); directories by trailing-slash path ("src/").
    // Null tree_hash returns an empty map.
    // #TODO (Later) : Add WorkspaceIndex Table and flatten the tree from there
    public async flatten_tree(
        tree_hash: string | null,
        prefix: string = "",
        depth: number = 0,
    ): Promise<PathMap> {
        if (!tree_hash) return {};

        if (depth > MAX_DEPTH)
            throw new InternalError(`Maximum directory nesting depth (${MAX_DEPTH}) exceeded at: ${prefix}`);

        const path_map: PathMap = {};
        const entries = await db.prisma.treeEntry.findMany({
            where: { parentTree: tree_hash },
            select: { name: true, entryType: true, objectHash: true },
        });

        for (const entry of entries) {
            const fullPath = prefix + entry.name;

            if (entry.entryType === "blob") {
                path_map[fullPath] = { type: "blob", hash: entry.objectHash };
            } else {
                // Recurse, then record the directory entry.
                const subPaths = await this.flatten_tree(entry.objectHash, fullPath + "/", depth + 1);
                Object.assign(path_map, subPaths);
                path_map[fullPath + "/"] = { type: "tree", hash: entry.objectHash };
            }
        }

        return path_map;
    }

    // Applies uncommitted changes to the parent tree, persisting only dirty tree
    // objects. Clean subtrees are reused by hash. Returns the new root tree hash.
    public async build_tree_from_changes(
        parentCommit: ParentCommitRef,
        changes: BuildTreeChange[],
        tx: Prisma.TransactionClient = db.prisma,
    ): Promise<string> {
        const parentRootTree = parentCommit.rootTree;

        const pathMap = await this.flatten_tree(parentRootTree);

        // Snapshot parent directory hashes before mutating, for clean-subtree reuse.
        const parentDirMap: Record<string, string> = {};
        if (parentRootTree) parentDirMap[""] = parentRootTree;
        for (const [path, info] of Object.entries(pathMap)) {
            if (info.type === "tree") parentDirMap[path] = info.hash;
        }

        // Validate changes: ADD must not clobber, MODIFY/DELETE require an existing entry.
        for (const change of changes) {
            const existing = pathMap[change.filePath];
            switch (change.action) {
                case "ADD":
                    if (existing) throw new ConflictError(`File already exists: ${change.filePath}`);
                    if (!change.blobHash) throw new InternalError(`ADD without a blob hash: ${change.filePath}`);
                    pathMap[change.filePath] = { type: "blob", hash: change.blobHash };
                    break;
                case "MODIFY":
                    if (!existing) throw new ConflictError(`File does not exist: ${change.filePath}`);
                    if (!change.blobHash) throw new InternalError(`MODIFY without a blob hash: ${change.filePath}`);
                    pathMap[change.filePath] = { type: "blob", hash: change.blobHash };
                    break;
                case "DELETE":
                    if (!existing) throw new ConflictError(`File does not exist: ${change.filePath}`);
                    delete pathMap[change.filePath];
                    break;
            }
        }

        // Mark all ancestor directories of changed files as dirty; root is always dirty.
        const dirtyDirs = new Set<string>([""]);
        for (const change of changes) {
            const segments = change.filePath.split("/");
            for (let i = 0; i < segments.length - 1; i++) {
                // Trailing slash convention for directory paths.
                dirtyDirs.add(segments.slice(0, i + 1).join("/") + "/");
            }
        }

        // Rebuild dirty trees bottom-up so each parent sees its children's new hashes.
        const sortedDirtyDirs = [...dirtyDirs].sort((a, b) => dirDepth(b) - dirDepth(a));
        const newTreeHashes: Record<string, string> = {};

        for (const dirPath of sortedDirtyDirs) {
            const children = this.getImmediateChildren(pathMap, dirPath);
            const entries: TreeChild[] = [];

            for (const [childName, childInfo] of children) {
                if (childInfo.type === "blob") {
                    entries.push({ type: "blob", name: childName, objectHash: childInfo.hash });
                    continue;
                }

                const childDirPath = dirPath + childName + "/";
                if (dirtyDirs.has(childDirPath)) {
                    // Dirty subtree — use the freshly computed hash.
                    entries.push({ type: "tree", name: childName, objectHash: newTreeHashes[childDirPath] });
                } else {
                    // Clean subtree — reuse parent's hash. A miss here is a bug.
                    const reuseHash = parentDirMap[childDirPath];
                    if (!reuseHash) {
                        throw new InternalError(
                            `Bug: clean subtree ${childDirPath} not found in parent commit; new directories must be dirty.`,
                        );
                    }
                    entries.push({ type: "tree", name: childName, objectHash: reuseHash });
                }
            }

            // Store the tree only if new — identical trees dedupe across commits.
            const treeHash = hashTrees(entries);
            const exists = await tx.tree.findUnique({ where: { treeHash }, select: { treeHash: true } });
            if (!exists) {
                await tx.tree.create({ data: { treeHash } });
                if (entries.length > 0) {
                    await tx.treeEntry.createMany({
                        data: entries.map((e) => ({
                            parentTree: treeHash,
                            entryType: e.type,
                            name: e.name,
                            objectHash: e.objectHash,
                        })),
                    });
                }
            }

            newTreeHashes[dirPath] = treeHash;
        }

        // Root tree hash is the commit snapshot identity.
        return newTreeHashes[""];
    }

    // Returns the direct children of `dirPath` from the flat path map.
    // Deeper paths are collapsed to their immediate subdirectory.
    private getImmediateChildren(
        pathMap: PathMap,
        dirPath: string,
    ): Map<string, { type: "blob"; hash: string } | { type: "tree" }> {
        const children = new Map<string, { type: "blob"; hash: string } | { type: "tree" }>();

        for (const [path, info] of Object.entries(pathMap)) {
            if (path === dirPath || !path.startsWith(dirPath)) continue;

            const relative = path.slice(dirPath.length);
            const slash = relative.indexOf("/");

            if (info.type === "blob" && slash === -1) {
                // Direct file.
                children.set(relative, { type: "blob", hash: info.hash });
            } else {
                // Subdirectory — take the first segment as the immediate child name.
                const childName = slash === -1 ? relative : relative.slice(0, slash);
                if (!children.has(childName)) children.set(childName, { type: "tree" });
            }
        }

        return children;
    }

    // Returns all parent hashes for a commit, ordered by ordinal.
    // Falls back to the scalar parent field for regular (non-merge) commits.
    public async getAllParents(commitHash: string): Promise<string[]> {
        const mergeParents = await db.prisma.commitParent.findMany({
            where: { commitHash },
            select: { parentHash: true },
            orderBy: { ordinal: "asc" },
        });

        if (mergeParents.length > 0) {
            return mergeParents.map((r) => r.parentHash);
        }

        // Non-merge commit — fall back to the scalar parent field.
        const commit = await db.prisma.commit.findUnique({
            where: { commitHash },
            select: { parent: true },
        });
        if (commit?.parent) return [commit.parent];
        return [];
    }

    // Finds the LCA of two commits using BFS. commitA = repoHead, commitB = workspaceHead.
    // Returns the path from LCA to commitB, or empty if histories are disjoint.
    public async mergeBase(commitA: string | null, commitB: string): Promise<(string | null)[]> {
        if (!commitB) return [];
        if (commitA === commitB) return [commitA];

        // Empty mainline — walk commitB's entire ancestry chain.
        if (commitA === null) {
            const trail: (string | null)[] = [commitB];
            let current = commitB;
            while (true) {
                const parents = await this.getAllParents(current);
                if (parents.length === 0) {
                    break;
                }
                current = parents[0];
                trail.push(current);
            }
            trail.push(null);
            // [null, first_commit, ..., workspaceHead]
            return trail.reverse();
        }

        // Tracks visited commits and their BFS depth.
        const visitedA = new Map<string, number>([[commitA, 0]]);
        const visitedB = new Map<string, number>([[commitB, 0]]);
        let queueA: string[] = [commitA];
        let queueB: string[] = [commitB];
        let lowestCommonAncestor: string | null = null;
        let isComplete = false;

        while (queueA.length > 0 || queueB.length > 0) {
            // BFS step from side A.
            if (queueA.length > 0) {
                const nextA: string[] = [];
                for (const current of queueA) {
                    if (isComplete) break;
                    const parents = await this.getAllParents(current);
                    for (const parent of parents) {
                        if (isComplete) break;
                        if (visitedB.has(parent)) {
                            lowestCommonAncestor = parent;
                            isComplete = true;
                            break;
                        }
                        if (!visitedA.has(parent)) {
                            visitedA.set(parent, visitedA.get(current)! + 1);
                            nextA.push(parent);
                        }
                    }
                }
                queueA = nextA;
            }

            // BFS step from side B.
            if (queueB.length > 0) {
                const nextB: string[] = [];
                for (const current of queueB) {
                    if (isComplete) break;
                    const parents = await this.getAllParents(current);
                    for (const parent of parents) {
                        if (isComplete) break;
                        if (visitedA.has(parent)) {
                            lowestCommonAncestor = parent;
                            isComplete = true;
                            break;
                        }
                        if (!visitedB.has(parent)) {
                            visitedB.set(parent, visitedB.get(current)! + 1);
                            nextB.push(parent);
                        }
                    }
                }
                queueB = nextB;
            }
            if (isComplete) break;
        }

        if (!lowestCommonAncestor) {
            return [];
        }

        // Walk back from commitB to the LCA, then reverse to get [LCA, ..., commitB].
        let current = commitB;
        const trail: string[] = [current];
        while (current !== lowestCommonAncestor) {
            const parents = await this.getAllParents(current);
            if (parents.length === 0) break;
            current = parents[0];
            trail.push(current);
        }

        return trail.reverse();
    }

    // Returns true if `ancestor` is reachable by walking back from `descendant`.
    public async isAncestorOf(ancestor: string, descendant: string): Promise<boolean> {
        if (ancestor === descendant) return true;

        const visited = new Set<string>();
        const queue: string[] = [descendant];

        while (queue.length > 0) {
            const current = queue.pop()!;
            if (current === ancestor) return true;
            if (visited.has(current)) continue;
            visited.add(current);

            const parents = await this.getAllParents(current);
            for (const parent of parents) {
                queue.push(parent);
            }
        }

        return false;
    }

    // Bakes uncommitted workspace changes into a new commit atomically:
    // builds the tree, stores the commit, advances HEAD via CAS, and clears changes.
    // CAS on `head` guards against concurrent commits.
    public async createCommit({ input, tx }: { input: CreateCommitInput, tx: Prisma.TransactionClient | null }): Promise<CreateCommitResult> {
        const { workspaceId, author, message } = input;
        const prismaClient = tx || db.prisma;

        // STEP 1: load the workspace and validate it can accept a commit.
        const workspace = await prismaClient.workspace.findUnique({
            where: { id: workspaceId },
            select: { head: true, status: true },
        });
        if (!workspace) throw new NotFoundError("Workspace not found");
        if (workspace.status !== "CLEAN") {
            throw new ConflictError(`Cannot commit while the workspace is ${workspace.status}.`);
        }

        const changes = await prismaClient.workspaceChange.findMany({
            where: { workspaceId },
            select: { filePath: true, action: true, blobHash: true },
        });
        if (changes.length === 0) throw new BadRequestError("Nothing to commit — no uncommitted changes.");

        // Root tree of the parent commit; null for the very first commit.
        const parentHead = workspace.head;
        const parentCommit = parentHead
            ? await prismaClient.commit.findUnique({
                where: { commitHash: parentHead },
                select: { rootTree: true },
            })
            : null;

        // Every ADD/MODIFY must reference a blob that was already uploaded.
        const referenced = [
            ...new Set(changes.filter((c) => c.action !== "DELETE" && c.blobHash).map((c) => c.blobHash as string)),
        ];
        if (referenced.length > 0) {
            const found = await prismaClient.blob.findMany({
                where: { blobHash: { in: referenced } },
                select: { blobHash: true },
            });
            const foundSet = new Set(found.map((b) => b.blobHash));
            const missing = referenced.filter((h) => !foundSet.has(h));
            if (missing.length > 0) {
                throw new BadRequestError(`Missing blob(s) for commit: ${missing.join(", ")}. Upload the content first.`);
            }
        }

        // Timestamp (unix seconds) is part of the commit hash.
        const committedAt = new Date();
        const timestamp = Math.floor(committedAt.getTime() / 1000);

        // All writes (tree objects, commit row, head advance, change deletion) are atomic.
        const runTransaction = async (txClient: Prisma.TransactionClient) => {
            // STEP 3: rebuild dirty trees; reuse clean subtrees by hash.
            const newRootTree = await this.build_tree_from_changes(
                { rootTree: parentCommit?.rootTree ?? null },
                changes,
                txClient,
            );

            // STEP 4: content-address the commit (no parent on first commit).
            const parents = parentHead ? [parentHead] : [];
            const commitHash = hashCommit({
                rootTree: newRootTree,
                parents,
                author,
                timestamp,
                timezone: COMMIT_TIMEZONE,
                message,
            });

            // STEP 5: store the commit; upsert dedupes identical snapshots.
            await txClient.commit.upsert({
                where: { commitHash },
                update: {},
                create: {
                    commitHash,
                    rootTree: newRootTree,
                    parent: parentHead,
                    author: `${author.name} <${author.email}>`,
                    timestamp: committedAt,
                    message,
                    parentWorkspaceId: workspaceId,
                },
            });

            // STEP 6: CAS — advance head only if it hasn't moved.
            const moved = await txClient.workspace.updateMany({
                where: { id: workspaceId, head: parentHead },
                data: { head: commitHash },
            });
            if (moved.count === 0) {
                throw new ConflictError("Concurrent commit detected — workspace head moved. Retry.");
            }

            // STEP 7: clear the now-committed changes.
            await txClient.workspaceChange.deleteMany({ where: { workspaceId } });

            return { commitHash, rootTree: newRootTree, parent: parentHead, changeCount: changes.length };
        };

        if (tx) {
            return runTransaction(tx);
        } else {
            return db.prisma.$transaction(runTransaction);
        }
    }

    // Recursively diffs two trees, returning a flat list of ADD/MODIFY/DELETE/RENAME entries.
    // Identical subtrees are skipped via hash comparison (Merkle shortcut).
    public async getTreeDiff(
        repoTreeHash: string | null,
        prTreeHash: string | null,
        currentPath: string = "",
    ): Promise<DiffEntry[]> {
        if (!repoTreeHash && !prTreeHash) return [];   // Nothing to compare.
        if (repoTreeHash === prTreeHash) return [];     // Identical subtree — skip.

        // Resolve both sides.
        const repoEntries = repoTreeHash
            ? (await this.resolveTrees(repoTreeHash)).entries
            : [];
        const prEntries = prTreeHash
            ? (await this.resolveTrees(prTreeHash)).entries
            : [];

        // Build name → entry maps for quick lookup.
        const repoMap = new Map<string, { type: TreeEntryType; objectHash: string; size?: number }>();
        for (const e of repoEntries) {
            repoMap.set(e.name, { type: e.type, objectHash: e.objectHash, size: e.size });
        }

        const prMap = new Map<string, { type: TreeEntryType; objectHash: string; size?: number }>();
        for (const e of prEntries) {
            prMap.set(e.name, { type: e.type, objectHash: e.objectHash, size: e.size });
        }

        // All unique names across both sides.
        const allNames = new Set<string>([...repoMap.keys(), ...prMap.keys()]);

        const diffs: DiffEntry[] = [];

        // Single-side entries are rename candidates.
        const deleteCandidates: { name: string; type: TreeEntryType; objectHash: string }[] = [];
        const addCandidates: { name: string; type: TreeEntryType; objectHash: string; size?: number }[] = [];

        // Pass 1: classify each name.
        for (const name of allNames) {
            const repoEntry = repoMap.get(name);
            const prEntry = prMap.get(name);

            if (repoEntry && prEntry) {
                if (repoEntry.objectHash === prEntry.objectHash) {
                    // Identical — skip.
                    continue;
                }

                if (repoEntry.type === "blob" && prEntry.type === "blob") {
                    // Same name, different blob → MODIFY.
                    diffs.push({
                        path: currentPath + name,
                        type: "blob",
                        changeType: "MODIFY",
                        oldObjectHash: repoEntry.objectHash,
                        newObjectHash: prEntry.objectHash,
                        size: prEntry.size,
                    });
                } else if (repoEntry.type === "tree" && prEntry.type === "tree") {
                    // Different directory hashes → recurse.
                    const subtreeDiffs = await this.getTreeDiff(
                        repoEntry.objectHash,
                        prEntry.objectHash,
                        currentPath + name + "/",
                    );
                    diffs.push(...subtreeDiffs);
                } else {
                    // Type mismatch (blob↔tree) — DELETE old, ADD new.
                    if (repoEntry.type === "tree") {
                        const deleted = await this.expandTreeAsDiff(
                            repoEntry.objectHash,
                            currentPath + name + "/",
                            "DELETE",
                        );
                        diffs.push(...deleted);
                    } else {
                        diffs.push({
                            path: currentPath + name,
                            type: "blob",
                            changeType: "DELETE",
                            oldObjectHash: repoEntry.objectHash,
                        });
                    }
                    // Expand new side as ADDs.
                    if (prEntry.type === "tree") {
                        const added = await this.expandTreeAsDiff(
                            prEntry.objectHash,
                            currentPath + name + "/",
                            "ADD",
                        );
                        diffs.push(...added);
                    } else {
                        diffs.push({
                            path: currentPath + name,
                            type: "blob",
                            changeType: "ADD",
                            newObjectHash: prEntry.objectHash,
                            size: prEntry.size,
                        });
                    }
                }
            } else if (repoEntry && !prEntry) {
                // Only in repo → DELETE or rename source.
                deleteCandidates.push({ name, type: repoEntry.type, objectHash: repoEntry.objectHash });
            } else if (!repoEntry && prEntry) {
                // Only in PR → ADD or rename target.
                addCandidates.push({ name, type: prEntry.type, objectHash: prEntry.objectHash, size: prEntry.size });
            }
        }

        // Pass 2: rename detection — match DELETE+ADD pairs with the same blob hash.
        const deletedByHash = new Map<string, typeof deleteCandidates[number][]>();
        for (const d of deleteCandidates) {
            if (d.type === "blob") {
                const list = deletedByHash.get(d.objectHash) ?? [];
                list.push(d);
                deletedByHash.set(d.objectHash, list);
            }
        }

        const matchedDeletes = new Set<string>(); // names consumed by a rename

        for (const addCandidate of addCandidates) {
            if (addCandidate.type !== "blob") continue;

            const matchingDeletes = deletedByHash.get(addCandidate.objectHash);
            if (matchingDeletes && matchingDeletes.length > 0) {
                // One rename per pair.
                const matchedDelete = matchingDeletes.shift()!;
                matchedDeletes.add(matchedDelete.name);

                diffs.push({
                    path: currentPath + addCandidate.name,
                    type: "blob",
                    changeType: "RENAME",
                    oldObjectHash: matchedDelete.objectHash,
                    newObjectHash: addCandidate.objectHash,
                    oldPath: currentPath + matchedDelete.name,
                    size: addCandidate.size,
                });
            }
        }

        // Pass 3: emit unmatched DELETEs and ADDs.
        for (const d of deleteCandidates) {
            if (matchedDeletes.has(d.name)) continue; // consumed by rename

            if (d.type === "tree") {
                // Deleted directory — expand all contained files as DELETEs.
                const deleted = await this.expandTreeAsDiff(
                    d.objectHash,
                    currentPath + d.name + "/",
                    "DELETE",
                );
                diffs.push(...deleted);
            } else {
                diffs.push({
                    path: currentPath + d.name,
                    type: "blob",
                    changeType: "DELETE",
                    oldObjectHash: d.objectHash,
                });
            }
        }

        for (const a of addCandidates) {
            // Skip renames already matched in pass 2.
            if (a.type === "blob" && diffs.some(
                (d) => d.changeType === "RENAME" && d.path === currentPath + a.name,
            )) {
                continue;
            }

            if (a.type === "tree") {
                // New directory — expand all contained files as ADDs.
                const added = await this.expandTreeAsDiff(
                    a.objectHash,
                    currentPath + a.name + "/",
                    "ADD",
                );
                diffs.push(...added);
            } else {
                diffs.push({
                    path: currentPath + a.name,
                    type: "blob",
                    changeType: "ADD",
                    newObjectHash: a.objectHash,
                    size: a.size,
                });
            }
        }

        return diffs;
    }

    // Recursively emits every blob in a tree as an ADD or DELETE DiffEntry.
    private async expandTreeAsDiff(
        treeHash: string,
        prefix: string,
        changeType: "ADD" | "DELETE",
    ): Promise<DiffEntry[]> {
        const entries = (await this.resolveTrees(treeHash)).entries;
        const diffs: DiffEntry[] = [];

        for (const entry of entries) {
            if (entry.type === "blob") {
                diffs.push({
                    path: prefix + entry.name,
                    type: "blob",
                    changeType,
                    ...(changeType === "DELETE"
                        ? { oldObjectHash: entry.objectHash }
                        : { newObjectHash: entry.objectHash, size: entry.size }),
                });
            } else {
                // Recurse into subdirectory
                const subDiffs = await this.expandTreeAsDiff(
                    entry.objectHash,
                    prefix + entry.name + "/",
                    changeType,
                );
                diffs.push(...subDiffs);
            }
        }

        return diffs;
    }

    // Runs a 3-way merge preview without writing to the DB.
    // oursCommitHash = repo HEAD, theirsCommitHash = workspace HEAD.
    public async threeWayTreeMerge(
        oursCommitHash: string | null,
        theirsCommitHash: string | null,
    ): Promise<MergeCheckResult> {
        // Empty repo — everything is a clean ADD, no conflicts possible.
        if (!theirsCommitHash) throw new NotFoundError("No PR head commit found")
        if (!oursCommitHash) {
            const theirsCommit = await db.prisma.commit.findUnique({
                where: { commitHash: theirsCommitHash },
                select: { rootTree: true },
            });
            if (!theirsCommit) throw new NotFoundError("Workspace head commit not found");

            const theirsMap = await this.flatten_tree(theirsCommit.rootTree);
            const mergedPaths: Record<string, MergedPathEntry> = {};
            let fileCount = 0;
            for (const [path, info] of Object.entries(theirsMap)) {
                if (info.type === "blob") {
                    mergedPaths[path] = { oldBlobHash: null, newBlobHash: info.hash };
                    fileCount++;
                }
            }

            return {
                canMerge: true,
                isFastForward: true,
                baseCommit: null,
                oursCommit: null,
                theirsCommit: theirsCommitHash,
                stats: { totalFiles: fileCount, cleanFiles: fileCount, conflictCount: 0 },
                conflicts: [],
                mergedPaths,
            };
        }

        // Same commit — nothing to merge.
        if (oursCommitHash === theirsCommitHash) {
            return {
                canMerge: true,
                isFastForward: true,
                baseCommit: oursCommitHash,
                oursCommit: oursCommitHash,
                theirsCommit: theirsCommitHash,
                stats: { totalFiles: 0, cleanFiles: 0, conflictCount: 0 },
                conflicts: [],
                mergedPaths: {},
            };
        }

        // STEP 1: compute the LCA. Empty trail means disjoint histories → null base.
        const mergeBaseTrail = await this.mergeBase(oursCommitHash, theirsCommitHash);
        const baseCommitHash = mergeBaseTrail.length > 0 ? mergeBaseTrail[0] : null;

        // STEP 2: fast-forward if repo HEAD is an ancestor of workspace HEAD.
        if (baseCommitHash === oursCommitHash) {
            const [oursCommit, theirsCommit] = await Promise.all([
                oursCommitHash ? db.prisma.commit.findUnique({ where: { commitHash: oursCommitHash }, select: { rootTree: true } }) : null,
                db.prisma.commit.findUnique({ where: { commitHash: theirsCommitHash }, select: { rootTree: true } }),
            ]);
            if (!theirsCommit) throw new NotFoundError("Workspace head commit not found");

            const [oursMap, theirsMap] = await Promise.all([
                this.flatten_tree(oursCommit?.rootTree ?? null),
                this.flatten_tree(theirsCommit.rootTree),
            ]);

            const mergedPaths: Record<string, MergedPathEntry> = {};
            let fileCount = 0;
            for (const [path, info] of Object.entries(theirsMap)) {
                if (info.type === "blob") {
                    mergedPaths[path] = { oldBlobHash: oursMap[path]?.hash ?? null, newBlobHash: info.hash };
                    fileCount++;
                }
            }

            return {
                canMerge: true,
                isFastForward: true,
                baseCommit: baseCommitHash,
                oursCommit: oursCommitHash,
                theirsCommit: theirsCommitHash,
                stats: { totalFiles: fileCount, cleanFiles: fileCount, conflictCount: 0 },
                conflicts: [],
                mergedPaths,
            };
        }

        // STEP 3: full 3-way merge — flatten base, ours, and theirs.
        const [baseCommit, oursCommit, theirsCommit] = await Promise.all([
            baseCommitHash
                ? db.prisma.commit.findUnique({ where: { commitHash: baseCommitHash }, select: { rootTree: true } })
                : null,
            db.prisma.commit.findUnique({ where: { commitHash: oursCommitHash }, select: { rootTree: true } }),
            db.prisma.commit.findUnique({ where: { commitHash: theirsCommitHash }, select: { rootTree: true } }),
        ]);

        if (!oursCommit) throw new NotFoundError("Repository head commit not found");
        if (!theirsCommit) throw new NotFoundError("Workspace head commit not found");

        const [baseMap, oursMap, theirsMap] = await Promise.all([
            this.flatten_tree(baseCommit?.rootTree ?? null),
            this.flatten_tree(oursCommit.rootTree),
            this.flatten_tree(theirsCommit.rootTree),
        ]);

        // STEP 4: collect all unique blob paths across all three trees.
        const allPaths = new Set<string>();
        for (const path of Object.keys(baseMap)) {
            if (baseMap[path].type === "blob") allPaths.add(path);
        }
        for (const path of Object.keys(oursMap)) {
            if (oursMap[path].type === "blob") allPaths.add(path);
        }
        for (const path of Object.keys(theirsMap)) {
            if (theirsMap[path].type === "blob") allPaths.add(path);
        }

        // STEP 5: classify each side's change and decide the merge outcome.
        const mergedPaths: Record<string, MergedPathEntry> = {};
        const conflicts: MergeConflictEntry[] = [];

        for (const path of allPaths) {
            const baseHash = baseMap[path]?.hash ?? null;
            const oursHash = oursMap[path]?.hash ?? null;
            const theirsHash = theirsMap[path]?.hash ?? null;

            const changeOurs = this.classifyChange(baseHash, oursHash);
            const changeTheirs = this.classifyChange(baseHash, theirsHash);

            const decision = this.mergeDecide(
                changeOurs, changeTheirs,
                oursHash, theirsHash, baseHash,
                path,
            );

            if (decision.type === "RESOLVED") {
                if (decision.hash !== null) {
                    mergedPaths[path] = { oldBlobHash: oursHash ?? null, newBlobHash: decision.hash };
                }
                // null hash = file deleted in merge, omit from tree.
            } else {
                conflicts.push(decision.conflict);
            }
        }

        const totalFiles = allPaths.size;
        const conflictCount = conflicts.length;
        const cleanFiles = totalFiles - conflictCount;

        return {
            canMerge: conflictCount === 0,
            isFastForward: false,
            baseCommit: baseCommitHash,
            oursCommit: oursCommitHash,
            theirsCommit: theirsCommitHash,
            stats: { totalFiles, cleanFiles, conflictCount },
            conflicts,
            mergedPaths,
        };
    }

    // Classifies how a file changed between BASE and one side.
    private classifyChange(
        baseHash: string | null,
        otherHash: string | null,
    ): MergeChangeClassification {
        if (baseHash === null && otherHash === null) return "UNCHANGED";
        if (baseHash === null && otherHash !== null) return "ADDED";
        if (baseHash !== null && otherHash === null) return "DELETED";
        if (baseHash === otherHash) return "UNCHANGED";
        return "MODIFIED";
    }

    // Given each side's classification, returns a resolved hash or a conflict.
    private mergeDecide(
        changeOurs: MergeChangeClassification,
        changeTheirs: MergeChangeClassification,
        oursHash: string | null,
        theirsHash: string | null,
        baseHash: string | null,
        path: string,
    ): { type: "RESOLVED"; hash: string | null } | { type: "CONFLICT"; conflict: MergeConflictEntry } {
        // Neither changed.
        if (changeOurs === "UNCHANGED" && changeTheirs === "UNCHANGED") {
            return { type: "RESOLVED", hash: baseHash };
        }

        // Only THEIRS changed.
        if (changeOurs === "UNCHANGED") {
            if (changeTheirs === "MODIFIED" || changeTheirs === "ADDED") {
                return { type: "RESOLVED", hash: theirsHash };
            }
            if (changeTheirs === "DELETED") {
                return { type: "RESOLVED", hash: null };
            }
        }

        // Only OURS changed.
        if (changeTheirs === "UNCHANGED") {
            if (changeOurs === "MODIFIED" || changeOurs === "ADDED") {
                return { type: "RESOLVED", hash: oursHash };
            }
            if (changeOurs === "DELETED") {
                return { type: "RESOLVED", hash: null };
            }
        }

        // Both deleted.
        if (changeOurs === "DELETED" && changeTheirs === "DELETED") {
            return { type: "RESOLVED", hash: null };
        }

        // Both added.
        if (changeOurs === "ADDED" && changeTheirs === "ADDED") {
            if (oursHash === theirsHash) {
                return { type: "RESOLVED", hash: oursHash };
            }
            return {
                type: "CONFLICT",
                conflict: {
                    filePath: path, conflictType: "ADD_ADD",
                    baseBlob: null, oursBlob: oursHash, theirsBlob: theirsHash,
                },
            };
        }

        // Both modified.
        if (changeOurs === "MODIFIED" && changeTheirs === "MODIFIED") {
            if (oursHash === theirsHash) {
                return { type: "RESOLVED", hash: oursHash };
            }
            return {
                type: "CONFLICT",
                conflict: {
                    filePath: path, conflictType: "EDIT_EDIT",
                    baseBlob: baseHash, oursBlob: oursHash, theirsBlob: theirsHash,
                },
            };
        }

        // One deleted, other modified.
        if (changeOurs === "DELETED" && changeTheirs === "MODIFIED") {
            return {
                type: "CONFLICT",
                conflict: {
                    filePath: path, conflictType: "DELETE_EDIT",
                    baseBlob: baseHash, oursBlob: null, theirsBlob: theirsHash,
                },
            };
        }
        if (changeOurs === "MODIFIED" && changeTheirs === "DELETED") {
            return {
                type: "CONFLICT",
                conflict: {
                    filePath: path, conflictType: "DELETE_EDIT",
                    baseBlob: baseHash, oursBlob: oursHash, theirsBlob: null,
                },
            };
        }

        // Unreachable fallback.
        return { type: "RESOLVED", hash: baseHash };
    }

    public async getSortedCommitsUnderWorkspace(workspaceId: string) {
        const commitTrail = await db.prisma.commit.findMany({
            where: {
                parentWorkspaceId: workspaceId
            },
            select: {
                message: true, commitHash: true, timestamp: true
            }
        });
        return commitTrail.sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
        );
    }
}
const storageService = StorageService.getInstance();

export default storageService;
