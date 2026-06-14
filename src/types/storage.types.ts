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