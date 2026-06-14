import crypto from "crypto";
import { CommitHashInput, CommitIdentity, TreeChild } from "../types/storage.types";

// Blob hashing (specs/04_version_control/02_hashing §3):
//
//   BLOB_HASH = SHA256( "blob" + "\0" + <size as decimal ASCII> + "\0" + <raw content bytes> )
//
// - size is the BYTE length of the content (not character count), written as
//   a decimal ASCII string — e.g. "11" for an 11-byte file, "0" for empty.
// - The payload is built from Buffers, never JS strings: interpolating bytes
//   into a string corrupts binary content, and string .length diverges from
//   byte length the moment content has multi-byte UTF-8 chars.
// - Output is the 64-char lowercase hex digest.

// Core, synchronous form — content already in memory as raw bytes.
export function hashBlobContent(content: Buffer): string {
    const header = Buffer.from(`blob\0${content.length}\0`, "ascii");
    return crypto.createHash("sha256").update(header).update(content).digest("hex");
}

// Convenience wrapper for Web API Blob/File objects (e.g. multipart uploads).
export async function hashBlob(blob: Blob): Promise<string> {
    const content = Buffer.from(await blob.arrayBuffer());
    return hashBlobContent(content);
}

// TREE_HASH = SHA256( "tree\0" + sorted child strings )
export function hashTrees(children: TreeChild[]): string {
    const sorted = [...children].sort((a, b) =>
        ((a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0)),
    );
    const childStrings = sorted.map((e) => `${e.type} ${e.name}\0${e.objectHash}`).join("");
    const bytes = Buffer.from(`tree\0${childStrings}`, "utf8");
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Commit hashing (specs/04_version_control/02_hashing §5):
//
//   content:
//     tree <root_tree_hash>\n
//     parent <parent_hash>\n          ← one line per parent; OMITTED entirely for the initial commit
//     author <name> <email> <unix_timestamp> <timezone>\n
//     committer <name> <email> <unix_timestamp> <timezone>\n
//     \n
//     <message>
//
//   COMMIT_HASH = SHA256( "commit" + "\0" + byte_length(content) + "\0" + content )
//
// Rules (§5.3):
// - Initial commit: no parent line at all (not "parent null" / empty).
// - Merge commit: one parent line per parent, IN ORDER — first is the main-line
//   parent (ours), second is the branch being merged in (theirs). Reordering
//   changes the hash.
// - byte_length is the UTF-8 BYTE count of the content, not the JS string length.

// `<name> <email> <unix_timestamp> <timezone>` — e.g. "Ayush <ayush@example.com> 1743264000 +0530"
function identityLine(identity: CommitIdentity, timestamp: number, timezone: string): string {
    return `${identity.name} <${identity.email}> ${timestamp} ${timezone}`;
}

// Exported separately — also needed by verify_commit (spec §8.3), which rebuilds
// the content from stored fields and recomputes the hash.
export function buildCommitContent(input: CommitHashInput): string {
    const committer = input.committer ?? input.author;

    const lines = [`tree ${input.rootTree}`];
    for (const parent of input.parents) {
        lines.push(`parent ${parent}`);
    }
    lines.push(`author ${identityLine(input.author, input.timestamp, input.timezone)}`);
    lines.push(`committer ${identityLine(committer, input.timestamp, input.timezone)}`);

    // Headers, then a blank line, then the raw message (which may itself contain newlines).
    return lines.join("\n") + "\n\n" + input.message;
}

export function hashCommit(input: CommitHashInput): string {
    const content = Buffer.from(buildCommitContent(input), "utf8");
    const header = Buffer.from(`commit\0${content.length}\0`, "ascii");
    return crypto.createHash("sha256").update(header).update(content).digest("hex");
}
