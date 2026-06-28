export type TreeChild = {
    type: "blob" | "tree";
    name: string;
    objectHash: string;
}

export type CommitIdentity = {
    name: string;
    email: string;  // bare address — angle brackets are added when building the content string
}

export type CommitHashInput = {
    rootTree: string;          // hash of the root tree for this snapshot
    parents: string[];         // [] = initial commit, [one] = normal, [ours, theirs] = merge (order matters!)
    author: CommitIdentity;
    committer?: CommitIdentity; // defaults to author (distinction exists for Git compatibility)
    timestamp: number;         // unix seconds — deliberately part of the hash (spec §5.5)
    timezone: string;          // UTC offset, e.g. "+0530"
    message: string;           // may contain newlines
}

export type TreeEntryType = "blob" | "tree"

// One node of the flat path map produced by flattening a tree (spec 03_commit
// §2.5). Files are keyed by their full path ("src/main.py"); directories by the
// path with a trailing slash ("src/") so an unchanged subtree can be reused by
// hash during commit rebuilds.
export type PathMapEntry = {
    type: TreeEntryType;
    hash: string;
}

export type PathMap = Record<string, PathMapEntry>;

export type TreeEntryResponse = {
    name: string;
    id: string;
    parentTree: string;
    entryType: TreeEntryType;
    objectHash: string;
}

// One entry of a resolved directory level (spec 03_commit §1.2). `size` is the
// blob byte count, present for blob entries only — trees have no intrinsic size.
export type ResolvedTreeEntry = {
    name: string;
    type: TreeEntryType;
    objectHash: string;
    size?: number;
}

export type ResolvedTree = {
    treeHash: string;
    entries: ResolvedTreeEntry[];
}

// Per-entry status for the workspace (committed + uncommitted) view, so the FE
// can highlight each row (spec 03_commit §1.5).
export type WorkspaceEntryStatus =
    | "COMMITTED"          // unchanged since the last commit
    | "MODIFIED"           // file content changed, not yet committed
    | "ADDED"              // new file/folder absent from the last commit
    | "DELETED"            // removed, deletion not yet committed
    | "SUBTREE_MODIFIED";  // folder with uncommitted changes somewhere inside

export type WorkspaceTreeEntry = {
    name: string;
    type: TreeEntryType;
    objectHash: string | null;  // null for a newly-added folder (no committed tree yet)
    size?: number;
    status: WorkspaceEntryStatus;
}

export type WorkspaceTree = {
    treeHash: string | null;
    entries: WorkspaceTreeEntry[];
}

export type ChangeAction = "ADD" | "MODIFY" | "DELETE";

// One workspace change fed into the commit rebuild (spec 03_commit §2.3).
// Mirrors a `workspace_changes` row: `blobHash` is null for a DELETE, set to the
// new content's blob for ADD/MODIFY.
export type BuildTreeChange = {
    filePath: string;
    action: ChangeAction;
    blobHash: string | null;
}

// Minimal parent-commit shape `build_tree_from_changes` reads: only the root
// tree hash. `null` means an initial commit on an empty repo — the parent tree
// is empty, so every change is an ADD. A full Commit row is structurally
// assignable to this.
export type ParentCommitRef = {
    rootTree: string | null;
}

// Inputs for create_commit (spec 03_commit §2.4). Ownership/permission checks
// happen in the controller; the service is handed an already-authorised author.
export type CreateCommitInput = {
    workspaceId: string;
    author: CommitIdentity;   // name + email, used both for the hash and the stored author string
    message: string;
}

// What the new commit looks like to the caller. `parent` is null for the first
// commit on an empty repo.
export type CreateCommitResult = {
    commitHash: string;
    rootTree: string;
    parent: string | null;
    changeCount: number;
}

// ---- Commit history endpoint (GET /commit/history/:repoId/:workspaceId) ----

// Request query for listing a workspace's commit history. Keyset pagination:
// `cursor` is the commitHash of the last entry from the previous page (omit on
// the first request); `limit` defaults to 20, capped at 100.
export type CommitHistoryRequest = {
    cursor?: string;
    limit?: number;
}

// One commit in the history list — stored metadata only. The tree contents are
// fetched separately via the workspace tree endpoints. `timestamp` is an ISO-8601
// string (the Prisma DateTime serialized in the JSON response).
export type CommitHistoryEntry = {
    commitHash: string;
    parent: string | null;   // null for the initial commit
    rootTree: string;
    author: string;          // "Name <email>" as stored
    message: string;
    timestamp: string;
}

// Response envelope, matching the workspace-list shape: entries in `data`,
// pagination as a sibling. `nextCursor` is null when there are no more pages.
export type CommitHistoryResponse = {
    status: "success";
    data: CommitHistoryEntry[];
    pagination: { nextCursor: string | null; hasMore: boolean };
}

// ---- PR Diff (GET /pr/diff/:repoId/:prId) ----

// The kind of change between two tree snapshots (repo HEAD vs PR HEAD).
export type DiffChangeType = "ADD" | "MODIFY" | "DELETE" | "RENAME";

// One entry in a PR diff result. Each entry represents a single file-level
// change between the repo's committed tree and the PR's committed tree.
export type DiffEntry = {
    path: string;              // full repo-root-relative path (e.g. "src/utils/foo.ts")
    type: TreeEntryType;       // "blob" or "tree"
    changeType: DiffChangeType;
    oldObjectHash?: string;    // repo-side hash (absent for ADD)
    newObjectHash?: string;    // PR-side hash (absent for DELETE)
    oldPath?: string;          // only for RENAME — the previous path
    size?: number;             // blob size on PR side (if available)
}