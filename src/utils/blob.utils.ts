import crypto from "crypto";
import { CommitHashInput, CommitIdentity, TreeChild } from "../types/storage.types";

// SHA256( "blob\0" + byte_length + "\0" + content )
// Uses Buffers to preserve binary content and get correct byte lengths.
export function hashBlobContent(content: Buffer): string {
    const header = Buffer.from(`blob\0${content.length}\0`, "ascii");
    return crypto.createHash("sha256").update(header).update(content).digest("hex");
}

// Wrapper for Web API Blob/File objects (e.g. multipart uploads).
export async function hashBlob(blob: Blob): Promise<string> {
    const content = Buffer.from(await blob.arrayBuffer());
    return hashBlobContent(content);
}

// SHA256( "tree\0" + sorted child strings )
export function hashTrees(children: TreeChild[]): string {
    const sorted = [...children].sort((a, b) =>
        ((a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0)),
    );
    const childStrings = sorted.map((e) => `${e.type} ${e.name}\0${e.objectHash}`).join("");
    const bytes = Buffer.from(`tree\0${childStrings}`, "utf8");
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

// SHA256( "commit\0" + byte_length + "\0" + content )
// Initial commit omits parent lines entirely; merge commits list parents in order.
function identityLine(identity: CommitIdentity, timestamp: number, timezone: string): string {
    return `${identity.name} <${identity.email}> ${timestamp} ${timezone}`;
}

export function buildCommitContent(input: CommitHashInput): string {
    const committer = input.committer ?? input.author;

    const lines = [`tree ${input.rootTree}`];
    for (const parent of input.parents) {
        lines.push(`parent ${parent}`);
    }
    lines.push(`author ${identityLine(input.author, input.timestamp, input.timezone)}`);
    lines.push(`committer ${identityLine(committer, input.timestamp, input.timezone)}`);

    return lines.join("\n") + "\n\n" + input.message;
}

export function hashCommit(input: CommitHashInput): string {
    const content = Buffer.from(buildCommitContent(input), "utf8");
    const header = Buffer.from(`commit\0${content.length}\0`, "ascii");
    return crypto.createHash("sha256").update(header).update(content).digest("hex");
}
