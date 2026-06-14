import { ResolvedTree, TreeEntryType, WorkspaceTree, WorkspaceTreeEntry } from "../types/storage.types";
import db from "./database.service";

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
}

const storageService = StorageService.getInstance();

export default storageService;
