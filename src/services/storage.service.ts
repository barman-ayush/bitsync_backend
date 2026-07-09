import { BadRequestError, ConflictError, InternalError, NotFoundError } from "../errors/app.error";
import { Prisma } from "../generated/prisma/client";
import { hashCommit, hashTrees } from "../utils/blob.utils";
import { BuildTreeChange, CommitIdentity, CreateCommitInput, CreateCommitResult, DiffEntry, MergeChangeClassification, MergeCheckResult, MergeConflictEntry, MergedPathEntry, ParentCommitRef, PathMap, ResolvedTree, TreeChild, TreeEntryType, WorkspaceTree, WorkspaceTreeEntry } from "../types/storage.types";
import db from "./database.service";

const MAX_DEPTH = 256;

// All BitSync timestamps are stored in IST (01_storage §7); the commit hash
// embeds the matching UTC offset so a recomputed hash verifies byte-for-byte.
const COMMIT_TIMEZONE = "+0530";

// Number of path segments in a directory prefix, used to order dirty dirs
// deepest-first for the bottom-up rebuild. "" -> 0, "src/" -> 1, "src/lib/" -> 2.
const dirDepth = (dirPath: string): number => (dirPath.match(/\//g) ?? []).length;
class StorageService {
    private static instance: StorageService;

    private constructor() { };

    public static getInstance(): StorageService {
        if (!this.instance) this.instance = new StorageService();

        return this.instance;
    }

    // resolveTrees : one directory level of a tree (spec 03_commit §1.3).
    // Lazy by design — subtrees are fetched on demand by separate calls, never
    // recursed here, so a huge repo never loads in one shot.
    //
    // Two batched queries, never N+1: (1) the tree's entries, (2) the sizes of
    // every blob entry in a single `IN`. Errors propagate to the caller's
    // handler rather than being swallowed — an empty directory and a failed
    // read must not look identical.
    public async resolveTrees(treeHash: string): Promise<ResolvedTree> {
        // Folders first, then files, each group alphabetical. The EntryType enum
        // is declared blob-before-tree, so Postgres orders blob < tree; `desc`
        // therefore puts trees (folders) ahead of blobs.
        const entries = await db.prisma.treeEntry.findMany({
            where: { parentTree: treeHash },
            select: { name: true, entryType: true, objectHash: true },
            orderBy: [{ entryType: "desc" }, { name: "asc" }],
        });

        // Collect distinct blob hashes and fetch all their sizes in one query.
        const blobHashes = [
            ...new Set(entries.filter((e) => e.entryType === "blob").map((e) => e.objectHash)),
        ];

        const sizeByHash = new Map<string, number>();
        if (blobHashes.length > 0) {
            const blobs = await db.prisma.blob.findMany({
                where: { blobHash: { in: blobHashes } },
                select: { blobHash: true, size: true },
            });
            // size is BigInt in the DB; file sizes fit in a JS number (< 2^53)
            // and BigInt is not JSON-serialisable, so coerce to Number here.
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

    // resolveWorkspaceTree : one directory level overlaid with the workspace's
    // uncommitted changes (spec 03_commit §1.4), tagging every entry with a
    // status so the FE can highlight added/modified/deleted/dirty rows.
    //
    // `currentPath` is a directory prefix the client builds as the user drills in
    // ("", then "src/", then "src/utils/"). `treeHash` is the committed tree for
    // this level, or null when the workspace has no commits yet (empty repo).
    public async resolveWorkspaceTree(
        workspaceId: string,
        treeHash: string | null,
        currentPath: string = "",
    ): Promise<WorkspaceTree> {
        // 1. Committed view of this level (empty when the workspace has no commits).
        const committed = treeHash ? (await this.resolveTrees(treeHash)).entries : [];

        // 2. Uncommitted changes under this prefix. `startsWith` compiles to a
        //    LIKE 'prefix%', which treats `_` and `%` as wildcards — so a prefix
        //    like "my_utils/" would also match "myXutils/". Re-assert the prefix
        //    exactly in JS to drop those over-matched rows.
        const rawChanges = await db.prisma.workspaceChange.findMany({
            where: { workspaceId, filePath: { startsWith: currentPath } },
            select: { filePath: true, action: true, blobHash: true },
        });
        const changes = rawChanges.filter((c) => c.filePath.startsWith(currentPath));

        // 3. Collapse to immediate children of currentPath. Anything nested deeper
        //    than one level only marks its top-level subfolder as modified — its
        //    own blobs are revealed when the user expands that folder.
        type Immediate =
            | { kind: "file"; action: string; blobHash: string | null }
            | { kind: "subtree" };
        const immediate = new Map<string, Immediate>();
        for (const c of changes) {
            const relative = c.filePath.slice(currentPath.length);
            const slash = relative.indexOf("/");
            if (slash === -1) {
                // direct file in this directory
                immediate.set(relative, { kind: "file", action: c.action, blobHash: c.blobHash });
            } else {
                // file deeper inside a subdirectory -> flag that subdirectory
                const subDirectory = relative.slice(0, slash) + "/";
                if (!immediate.has(subDirectory)) immediate.set(subDirectory, { kind: "subtree" });
            }
        }

        // Batch-fetch sizes for every blob referenced by a change (one query).
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

        // 4. Merge committed entries with the changes that touch them. Trees match
        //    a subtree marker ("name/"); blobs match a file change ("name").
        for (const entry of committed) {
            // Folder cases
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

            // Files
            const change = immediate.get(entry.name);
            if (!change || change.kind !== "file") {
                // This file was not touched in uncommitted changes
                result.push({ ...entry, status: "COMMITTED" });
                continue;
            }

            // This file was modified/deleted in the uncommitted changes
            immediate.delete(entry.name);

            if (change.action === "DELETE") {
                result.push({ ...entry, status: "DELETED" });
            } else {
                // MODIFY (or a degenerate ADD over an existing path): new content.
                result.push({
                    name: entry.name,
                    type: "blob",
                    objectHash: change.blobHash,
                    size: change.blobHash ? sizeByHash.get(change.blobHash) : undefined,
                    status: "MODIFIED",
                });
            }
        }

        // 5. Anything left has no committed counterpart — newly added files/folders.
        for (const [name, change] of immediate) {
            if (change.kind === "subtree") {
                // a new file under a path with no committed tree implies a new folder
                result.push({ name: name.slice(0, -1), type: "tree", objectHash: null, status: "ADDED" });
            } else if (change.action === "ADD" || change.action === "MODIFY") {
                // ADD = brand-new file. A MODIFY with no committed entry is a data
                // inconsistency; surface it as added rather than dropping it.
                result.push({
                    name,
                    type: "blob",
                    objectHash: change.blobHash,
                    size: change.blobHash ? sizeByHash.get(change.blobHash) : undefined,
                    status: "ADDED",
                });
            }
            // a leftover DELETE has nothing to show — not committed here, now gone.
        }

        // Folders first, then files, alphabetical within each (type DESC, name ASC).
        result.sort((a, b) =>
            a.type !== b.type
                ? a.type < b.type ? 1 : -1
                : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );

        return { treeHash, entries: result };
    }

    // lookupBlobAtPath : resolve a repo-root-relative file path against a
    // committed root tree, returning the blob hash stored there, or null if the
    // path does not exist as a file in that tree. This is the authoritative
    // "what does HEAD have at this path?" check that decides ADD vs MODIFY vs
    // DELETE when staging workspace changes.
    //
    // Walks one directory level per path segment (treeEntry is keyed by
    // (parentTree, name)). Returns null the moment a segment is missing, or a
    // non-final segment is a blob rather than a tree (a file can't have children).
    public async lookupBlobAtPath(
        rootTreeHash: string | null,
        filePath: string,
    ): Promise<string | null> {
        if (!rootTreeHash) return null;

        const segments = filePath.split("/");
        // Non-null from here (rootTreeHash was guarded above); reassigned to each
        // descended subtree. Explicitly typed to break the inference cycle with
        // `entry.objectHash` feeding back into the next findUnique argument.
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
                // The path resolves to a file only if the final entry is a blob.
                return entry.entryType === "blob" ? entry.objectHash : null;
            }

            // Intermediate segment must be a directory to descend into.
            if (entry.entryType !== "tree") return null;
            currentTree = entry.objectHash;
        }

        return null;
    }

    // flatten_tree : recursively walk a tree and produce a flat path -> hash map
    // (spec 03_commit §2.5). This is the bottleneck of commit creation: every
    // file in the parent commit is visited once, O(n) in repo size.
    //
    // Blobs are keyed by full path ("src/main.py"); directories are *also*
    // recorded under their trailing-slash path ("src/") alongside their children,
    // so the rebuild step can reuse an unchanged subtree by its hash. A null
    // tree_hash (empty repo with no commits) flattens to an empty map, never null,
    // so the recursive merge and downstream callers never need a null check.
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
                // Recurse into the subdirectory, then record the directory itself.
                const subPaths = await this.flatten_tree(entry.objectHash, fullPath + "/", depth + 1);
                Object.assign(path_map, subPaths);
                path_map[fullPath + "/"] = { type: "tree", hash: entry.objectHash };
            }
        }

        return path_map;
    }

    // build_tree_from_changes : given the parent commit and a set of uncommitted
    // changes, produce the new root tree hash, persisting every tree object that
    // lies on a dirty path (spec 03_commit §2.3). Clean subtrees are reused by
    // hash reference, so only O(changes * depth) tree objects are written.
    //
    // Pass `tx` to run inside the commit's transaction (atomic with the commit
    // insert); it defaults to the shared client. Returns the root tree hash — the
    // caller stores it as `commit.root_tree`.
    public async build_tree_from_changes(
        parentCommit: ParentCommitRef,
        changes: BuildTreeChange[],
        tx: Prisma.TransactionClient = db.prisma,
    ): Promise<string> {
        const parentRootTree = parentCommit.rootTree;

        const pathMap = await this.flatten_tree(parentRootTree);

        // Snapshot the parent's directory -> tree_hash map *before* mutating, for
        // clean-subtree reuse. flatten_tree records every directory under its
        // trailing-slash key, so we lift those out plus the root ("").
        const parentDirMap: Record<string, string> = {};
        if (parentRootTree) parentDirMap[""] = parentRootTree;
        for (const [path, info] of Object.entries(pathMap)) {
            if (info.type === "tree") parentDirMap[path] = info.hash;
        }

        // ADD must not clobber, MODIFY/DELETE must hit an existing file.
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

        // Mark every ancestor directory of each changed file as dirty.
        // The root ("") is always dirty when there is at least one change.
        const dirtyDirs = new Set<string>([""]);
        for (const change of changes) {
            const segments = change.filePath.split("/");
            for (let i = 0; i < segments.length - 1; i++) {
                // dirtyDirs contain file path with trailing slashes
                dirtyDirs.add(segments.slice(0, i + 1).join("/") + "/");
            }
        }

        // Rebuild dirty trees bottom-up (deepest first) so a parent always
        // sees its children's freshly computed hashes in `newTreeHashes`.
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
                    // Dirty subtree — point at the hash we just built for it.
                    entries.push({ type: "tree", name: childName, objectHash: newTreeHashes[childDirPath] });
                } else {
                    // Clean subtree — reuse the parent commit's hash untouched. A new
                    // directory would have been marked dirty, so a miss here is a bug.
                    const reuseHash = parentDirMap[childDirPath];
                    if (!reuseHash) {
                        throw new InternalError(
                            `Bug: clean subtree ${childDirPath} not found in parent commit; new directories must be dirty.`,
                        );
                    }
                    entries.push({ type: "tree", name: childName, objectHash: reuseHash });
                }
            }

            // Content-address the tree, then store it (and its entries) only when
            // this exact hash is new — identical trees dedupe across commits.
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

        // The root tree hash is the snapshot's identity.
        return newTreeHashes[""];
    }

    // getImmediateChildren : collapse the flat path map to the direct children of
    // `dirPath` (spec 03_commit §2.7). A direct file becomes a blob child; any
    // deeper path collapses to its top-level subdirectory marked as a tree.
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
                // Direct file in this directory, e.g. "main.py".
                children.set(relative, { type: "blob", hash: info.hash });
            } else {
                // A subdirectory — either its own trailing-slash entry or a nested
                // file/dir below it. First segment names the immediate child.
                const childName = slash === -1 ? relative : relative.slice(0, slash);
                if (!children.has(childName)) children.set(childName, { type: "tree" });
            }
        }

        return children;
    }

    // getAllParents : return every parent hash for a commit, ordered by ordinal
    // (spec 01_storage §5.1). Merge commits store their parents in the
    // `commit_parents` join table; regular commits have a single `parent` field.
    // Falls back to the scalar parent when no `commit_parents` rows exist, so
    // all graph walkers can use a single code-path.
    public async getAllParents(commitHash: string): Promise<string[]> {
        const mergeParents = await db.prisma.commitParent.findMany({
            where: { commitHash },
            select: { parentHash: true },
            orderBy: { ordinal: "asc" },
        });

        if (mergeParents.length > 0) {
            return mergeParents.map((r) => r.parentHash);
        }

        // Regular (non-merge) commit — fall back to the single parent field.
        const commit = await db.prisma.commit.findUnique({
            where: { commitHash },
            select: { parent: true },
        });
        if (commit?.parent) return [commit.parent];
        return [];
    }

    // merge_base : Find the LCA using multisource BFS.
    // convention : commitA -> repoHead, commitB -> workspaceHead
    // LCA always lies on the main repo commit line (returned null when empty repo)
    public async mergeBase(commitA: string | null, commitB: string): Promise<(string | null)[]> {
        if (!commitB) return [];
        if (commitA === commitB) return [commitA];

        // Case: commitA is null (e.g. empty repository mainline)
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
            // trail.reverse() = [null, workspace_first_commit , ... , workspaceHead]
            // LCA is null as mainline is empty, there is no LCA
            return trail.reverse();
        }

        // commit_hash → depth from the starting tip.
        const visitedA = new Map<string, number>([[commitA, 0]]);
        const visitedB = new Map<string, number>([[commitB, 0]]);
        let queueA: string[] = [commitA];
        let queueB: string[] = [commitB];
        let commitTrail: string[] = [];
        let isComplete = false;
        let lowestCommonAncestor: string | null = null;


        while (queueA.length > 0 || queueB.length > 0) {
            // Expand one level from side A.
            if (queueA.length > 0) {
                const nextA: string[] = [];
                for (const current of queueA) {
                    if (isComplete) break;
                    const parents = await this.getAllParents(current);
                    for (const parent of parents) {
                        if (isComplete) break;
                        if (visitedB.has(parent)) {
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

            // Expand one level from side B.
            if (queueB.length > 0) {
                const nextB: string[] = [];
                for (const current of queueB) {
                    if (isComplete) break;
                    const parents = await this.getAllParents(current);
                    for (const parent of parents) {
                        if (isComplete) break;
                        if (visitedA.has(parent)) {
                            // the lca is found and laready visited;
                            commitTrail.push(parent);
                            lowestCommonAncestor = parent;
                            isComplete = true;
                            break;
                        }
                        if (!visitedB.has(parent)) {
                            visitedB.set(parent, visitedB.get(current)! + 1);
                            nextB.push(parent);
                            commitTrail.push(parent);
                        }
                    }
                }
                queueB = nextB;
            }
            if (isComplete) break;
        }
        // expected structure : 
        // [ lowestCommonAncestor, .... , workspaceHead ]
        let finalCommitTrail: string[] = [];
        if (lowestCommonAncestor) {
            for (const commit of commitTrail) {
                finalCommitTrail.push(commit);
                if (commit == lowestCommonAncestor) break;
            }
        }

        return finalCommitTrail;

    }

    // isAncestorOf : check if `ancestor` is reachable by walking back from
    // `descendant` through all parents (spec 01_storage §5.1). Single BFS
    // that short-circuits the moment the target is found.
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

    // createCommit : bake a workspace's uncommitted changes into a new commit
    // (spec 03_commit §2.4). Builds the new tree (reusing clean subtrees), stores
    // the commit, advances the workspace head with a compare-and-swap, and clears
    // the now-committed changes — all in one transaction so a half-applied commit
    // can never land. Ownership and permissions are enforced by the caller.
    //
    // The compare-and-swap on `head` (STEP 6) is the only concurrency guard: if a
    // second commit moved the head after we read it, the CAS matches zero rows and
    // we abort rather than silently overwriting the first commit.
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

        // Parent commit's root tree (null on the first commit of an empty repo,
        // where every change is necessarily an ADD).
        const parentHead = workspace.head;
        const parentCommit = parentHead
            ? await prismaClient.commit.findUnique({
                where: { commitHash: parentHead },
                select: { rootTree: true },
            })
            : null;

        //  Every ADD/MODIFY must reference an already-uploaded blob (blobs
        //  are uploaded before the commit request — 01_storage §3.6).
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

        // Timestamp is part of the commit hash as unix seconds (spec §5.5); the
        // matching Date is stored on the row, in IST like every other timestamp.
        const committedAt = new Date();
        const timestamp = Math.floor(committedAt.getTime() / 1000);

        // the new tree objects, the commit row, the
        // head advance, and the cleared changes either all land or none do.
        const runTransaction = async (txClient: Prisma.TransactionClient) => {
            // STEP 3: rebuild only the trees on dirty paths; reuse the rest by hash.
            const newRootTree = await this.build_tree_from_changes(
                { rootTree: parentCommit?.rootTree ?? null },
                changes,
                txClient,
            );

            // STEP 4: content-address the commit. Initial commit omits the parent
            // line entirely, so `parents` is empty when there is no head yet.
            const parents = parentHead ? [parentHead] : [];
            const commitHash = hashCommit({
                rootTree: newRootTree,
                parents,
                author,
                timestamp,
                timezone: COMMIT_TIMEZONE,
                message,
            });

            // STEP 5: store the commit. Upsert on the hash dedups an identical
            // snapshot (same tree, parent, author, timestamp, message).
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

            // STEP 6: advance the head only if it still points where we read it.
            const moved = await txClient.workspace.updateMany({
                where: { id: workspaceId, head: parentHead },
                data: { head: commitHash },
            });
            if (moved.count === 0) {
                throw new ConflictError("Concurrent commit detected — workspace head moved. Retry.");
            }

            // STEP 7: the changes are now baked into the commit — clear them.
            await txClient.workspaceChange.deleteMany({ where: { workspaceId } });

            return { commitHash, rootTree: newRootTree, parent: parentHead, changeCount: changes.length };
        };

        if (tx) {
            return runTransaction(tx);
        } else {
            return db.prisma.$transaction(runTransaction);
        }
    }

    // getTreeDiff : recursively compare two tree snapshots and produce a flat
    // list of file-level changes (ADD, MODIFY, DELETE, RENAME). Identical
    // subtrees are short-circuited by hash (Merkle optimisation), so only
    // divergent branches are walked.
    //
    // `repoTreeHash` is the root tree of the repo's HEAD commit (null if the
    // repo has no commits yet — everything in the PR is an ADD).
    // `prTreeHash` is the root tree of the PR's head commit.
    // `currentPath` is the directory prefix built as we recurse ("", "src/", …).
    public async getTreeDiff(
        repoTreeHash: string | null,
        prTreeHash: string | null,
        currentPath: string = "",
    ): Promise<DiffEntry[]> {
        // Both null → nothing to compare.
        if (!repoTreeHash && !prTreeHash) return [];

        // Same hash → identical subtree, no changes at all.
        if (repoTreeHash === prTreeHash) return [];

        // ── Resolve both sides ──────────────────────────────────────────────
        const repoEntries = repoTreeHash
            ? (await this.resolveTrees(repoTreeHash)).entries
            : [];
        const prEntries = prTreeHash
            ? (await this.resolveTrees(prTreeHash)).entries
            : [];

        // Build lookup maps: name → { type, objectHash, size? }
        const repoMap = new Map<string, { type: TreeEntryType; objectHash: string; size?: number }>();
        for (const e of repoEntries) {
            repoMap.set(e.name, { type: e.type, objectHash: e.objectHash, size: e.size });
        }

        const prMap = new Map<string, { type: TreeEntryType; objectHash: string; size?: number }>();
        for (const e of prEntries) {
            prMap.set(e.name, { type: e.type, objectHash: e.objectHash, size: e.size });
        }

        // Collect all unique names across both sides.
        const allNames = new Set<string>([...repoMap.keys(), ...prMap.keys()]);

        const diffs: DiffEntry[] = [];

        // Candidates for rename detection — names that exist on only one side.
        const deleteCandidates: { name: string; type: TreeEntryType; objectHash: string }[] = [];
        const addCandidates: { name: string; type: TreeEntryType; objectHash: string; size?: number }[] = [];

        // ── Pass 1: classify each name ──────────────────────────────────────
        for (const name of allNames) {
            const repoEntry = repoMap.get(name);
            const prEntry = prMap.get(name);

            if (repoEntry && prEntry) {
                // Name exists on BOTH sides.
                if (repoEntry.objectHash === prEntry.objectHash) {
                    // Identical content — skip (unchanged).
                    continue;
                }

                if (repoEntry.type === "blob" && prEntry.type === "blob") {
                    // Same name, different blob hash → MODIFY.
                    diffs.push({
                        path: currentPath + name,
                        type: "blob",
                        changeType: "MODIFY",
                        oldObjectHash: repoEntry.objectHash,
                        newObjectHash: prEntry.objectHash,
                        size: prEntry.size,
                    });
                } else if (repoEntry.type === "tree" && prEntry.type === "tree") {
                    // Both are directories with different hashes → recurse.
                    const subtreeDiffs = await this.getTreeDiff(
                        repoEntry.objectHash,
                        prEntry.objectHash,
                        currentPath + name + "/",
                    );
                    diffs.push(...subtreeDiffs);
                } else {
                    // Type mismatch (blob↔tree) — treat as DELETE old + ADD new.
                    // Expand the old side fully as DELETEs.
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
                    // Expand the new side fully as ADDs.
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
                // Name exists ONLY in repo → candidate for DELETE (or rename source).
                deleteCandidates.push({ name, type: repoEntry.type, objectHash: repoEntry.objectHash });
            } else if (!repoEntry && prEntry) {
                // Name exists ONLY in PR → candidate for ADD (or rename target).
                addCandidates.push({ name, type: prEntry.type, objectHash: prEntry.objectHash, size: prEntry.size });
            }
        }

        // ── Pass 2: rename detection among DELETE/ADD candidates ─────────────
        // A rename is a blob DELETE + blob ADD with the same objectHash.
        // Build a reverse map: blobHash → deleted candidate(s).
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
                // Pop the first matching delete — one rename per pair.
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

        // ── Pass 3: emit remaining (unmatched) DELETEs and ADDs ─────────────
        for (const d of deleteCandidates) {
            if (matchedDeletes.has(d.name)) continue; // already consumed by rename

            if (d.type === "tree") {
                // Deleted directory — expand all files inside as individual DELETEs.
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
            // Skip if this ADD was already matched as a rename.
            if (a.type === "blob" && diffs.some(
                (d) => d.changeType === "RENAME" && d.path === currentPath + a.name,
            )) {
                continue;
            }

            if (a.type === "tree") {
                // New directory — expand all files inside as individual ADDs.
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

    // expandTreeAsDiff : recursively walk a tree and emit every blob as a
    // DiffEntry of the given changeType (ADD or DELETE). Used when an entire
    // directory appears or disappears between the two compared trees.
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
                // Recurse into subdirectory.
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

    // threeWayTreeMerge : run the full 3-way merge algorithm (spec §4.1) and
    // return a preview result without writing anything to the database. Used by
    // the merge-check endpoint so the frontend can show conflicts before the
    // user triggers the actual merge.
    //
    // Inputs:
    //   oursCommitHash   — repo.headCommit (null if repo is empty → everything is clean ADD)
    //   theirsCommitHash — workspace.head / pr_head
    //
    // Internally computes merge_base to find the BASE commit, then flattens all
    // three trees and runs the classify/decide matrix per file path.
    public async threeWayTreeMerge(
        oursCommitHash: string | null,
        theirsCommitHash: string | null,
    ): Promise<MergeCheckResult> {
        // ── Edge case: repo has no commits yet ──────────────────────────────
        // Everything in the workspace is a clean ADD; no conflicts possible.
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

        // ── Same commit — nothing to merge ──────────────────────────────────
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

        // ── STEP 1: Compute the merge base (LCA) ───────────────────────────
        const mergeBaseTrail = await this.mergeBase(oursCommitHash, theirsCommitHash);
        // mergeBase returns [ lca, ..., workspaceHead ] — element [0] is the LCA
        // when it is found inside visitedA. If the trail is empty, oursCommit is
        // unreachable from theirsCommit (disjoint histories); treat as null base.
        const baseCommitHash = mergeBaseTrail.length > 0 ? mergeBaseTrail[0] : null;

        // ── STEP 2: Detect fast-forward ─────────────────────────────────────
        if (baseCommitHash === oursCommitHash) {
            // Repo HEAD is an ancestor of workspace HEAD — fast-forward.
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

        // ── STEP 3: Full 3-way merge — flatten all three trees ──────────────
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

        // ── STEP 4: Collect all unique file paths (exclude directories) ─────
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

        // ── STEP 5: Classify and decide per path (spec §4.2 / §4.3) ────────
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
                // else: file is deleted in the merge — omit from merged tree
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

    // classifyChange : how did a file change between BASE and one side?
    // (spec §4.2 — "classify" helper)
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

    // mergeDecide : given how each side changed, produce a resolved hash or a
    // conflict record. Follows the decision table in spec §4.3.
    private mergeDecide(
        changeOurs: MergeChangeClassification,
        changeTheirs: MergeChangeClassification,
        oursHash: string | null,
        theirsHash: string | null,
        baseHash: string | null,
        path: string,
    ): { type: "RESOLVED"; hash: string | null } | { type: "CONFLICT"; conflict: MergeConflictEntry } {
        // ── Neither side changed ──
        if (changeOurs === "UNCHANGED" && changeTheirs === "UNCHANGED") {
            return { type: "RESOLVED", hash: baseHash };
        }

        // ── Only THEIRS changed ──
        if (changeOurs === "UNCHANGED") {
            if (changeTheirs === "MODIFIED" || changeTheirs === "ADDED") {
                return { type: "RESOLVED", hash: theirsHash };
            }
            if (changeTheirs === "DELETED") {
                return { type: "RESOLVED", hash: null };
            }
        }

        // ── Only OURS changed ──
        if (changeTheirs === "UNCHANGED") {
            if (changeOurs === "MODIFIED" || changeOurs === "ADDED") {
                return { type: "RESOLVED", hash: oursHash };
            }
            if (changeOurs === "DELETED") {
                return { type: "RESOLVED", hash: null };
            }
        }

        // ── Both sides deleted ──
        if (changeOurs === "DELETED" && changeTheirs === "DELETED") {
            return { type: "RESOLVED", hash: null };
        }

        // ── Both sides added ──
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

        // ── Both sides modified ──
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

        // ── One deleted, other modified ──
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

        // Fallback — should be unreachable.
        return { type: "RESOLVED", hash: baseHash };
    }
}
const storageService = StorageService.getInstance();

export default storageService;
