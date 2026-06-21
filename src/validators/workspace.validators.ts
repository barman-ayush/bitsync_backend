import { z } from "zod";

export const workspaceSchema = z.object({
    repoId: z.string().uuid(),
    name: z.string().max(255)
});

// Cursor pagination for the workspace list (infinite scroll). `cursor` is the
// id of the last workspace from the previous page; omitted on the first request.
export const listWorkspaceQuerySchema = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Availability check for a workspace name (e.g. live validation in the create form).
export const checkWorkspaceNameSchema = z.object({
    repoId: z.string().uuid(),
    workspaceName: z.string().min(1).max(255),
});

export const workspaceTreeParamsSchema = z.object({
    repoId: z.string().uuid(),
    workspaceId: z.string().uuid(),
});

// Body for creating a commit from a workspace's uncommitted changes. The author
// comes from the authenticated user and the changes from workspace_changes — the
// client supplies only the commit message.
export const createCommitSchema = z.object({
    message: z.string().trim().min(1, "Commit message is required.").max(1000),
});

// Query for a workspace's commit history (infinite scroll). `cursor` is the
// commitHash of the last commit from the previous page; omitted on the first
// request. Commit hashes are 64-char lowercase hex sha256 (02_hashing).
export const listCommitHistoryQuerySchema = z.object({
    cursor: z
        .string()
        .regex(/^[a-f0-9]{64}$/, "cursor must be a commit hash (64-char lowercase hex sha256).")
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Params for fetching a blob's signed download URL. blobHash is the
// content-addressed id (64-char lowercase hex sha256).
export const blobDownloadParamsSchema = z.object({
    repoId: z.string().uuid(),
    blobHash: z.string().regex(/^[a-f0-9]{64}$/, "blob_hash must be a 64-char lowercase hex sha256."),
});

// Query for one directory level of a workspace tree.
//   path      : directory prefix the FE builds while drilling in ("" = root,
//               otherwise must end in "/", e.g. "src/utils/"). No leading slash
//               or ".." — it is prefix-matched against stored file paths.
//   tree_hash : committed tree backing this level, taken from the parent
//               listing's object_hash. Omitted at the root (derived from the
//               workspace head) and for newly-added folders (no committed tree).
export const workspaceTreeQuerySchema = z.object({
    path: z
        .string()
        .max(1024)
        .optional()
        .default("")
        .refine(
            (p) => p === "" || (p.endsWith("/") && !p.startsWith("/") && !p.includes("..")),
            "path must be a directory prefix ending in '/' (e.g. \"src/utils/\").",
        ),
    tree_hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/, "tree_hash must be a 64-char lowercase hex sha256.")
        .optional(),
});

// A repo-root-relative file path, per 01_storage §3.6: forward slashes only, no
// leading/trailing slash, no consecutive slashes, no ".." traversal segment.
const filePathSchema = z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => !p.startsWith("/") && !p.endsWith("/"), "file_path must not start or end with '/'.")
    .refine((p) => !p.includes("//"), "file_path must not contain consecutive slashes.")
    .refine((p) => !p.split("/").includes(".."), "file_path must not contain a '..' segment.");

// Batch upsert of uncommitted changes into workspace_changes. The client sends
// only (filePath, blobHash) — the server derives ADD/MODIFY/DELETE by comparing
// against the workspace HEAD tree. blobHash is null to signal a removal; a
// 64-char hex hash otherwise (the blob must already be uploaded).
export const uploadChangesSchema = z.object({
    changes: z
        .array(
            z.object({
                filePath: filePathSchema,
                blobHash: z
                    .string()
                    .regex(/^[a-f0-9]{64}$/, "blob_hash must be a 64-char lowercase hex sha256.")
                    .nullable(),
            }),
        )
        .min(1)
        .max(1000)
        .refine(
            (arr) => new Set(arr.map((c) => c.filePath)).size === arr.length,
            "changes must not contain duplicate file paths.",
        ),
});