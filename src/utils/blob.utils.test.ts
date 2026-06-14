import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { buildCommitContent, hashBlob, hashBlobContent, hashCommit } from "./blob.utils";
import { CommitHashInput } from "../types/storage.types";

// Known-answer vectors, precomputed from the spec formula
// SHA256("blob\0" + size + "\0" + content) — specs/04_version_control/02_hashing §3.3
const VECTORS = {
    // "hello world" (11 bytes, no trailing newline) → "blob\011\0hello world"
    helloWorld: "7735580ea8bc42e082da9fb6704a2dab416b39888fb0411b1361b472a497fc0f",
    // empty file (0 bytes) → "blob\00\0"
    empty: "0bf2bc1c289fc58cb8cc7ba98fcfb9951f85aa1564b1110a48d45c0c7f4ddea5",
    // "héllo" — 5 chars but 6 BYTES in UTF-8; header must say 6
    utf8: "fbb91f748ab5997e44fbdda5b96395670639e4a345ad7059287762872e2d7402",
    // raw bytes [0x00, 0xff, 0x10, 0x00, 0x2a] — null bytes and non-UTF8 content
    binary: "5304733aa0d2fd9a1dc20385438218652b139c615aa82a7e55c299778276da86",
};

const NUL = Buffer.from([0x00]);

describe("hashBlobContent", () => {
    it("matches the spec example: 'hello world'", () => {
        assert.equal(hashBlobContent(Buffer.from("hello world")), VECTORS.helloWorld);
    });

    it("matches the spec example: empty file", () => {
        assert.equal(hashBlobContent(Buffer.alloc(0)), VECTORS.empty);
    });

    it("uses BYTE length, not character count, for multi-byte UTF-8", () => {
        const content = Buffer.from("héllo", "utf8");
        assert.equal(content.length, 6); // sanity: 5 chars, 6 bytes
        assert.equal(hashBlobContent(content), VECTORS.utf8);
    });

    it("handles binary content with null and non-UTF8 bytes", () => {
        assert.equal(hashBlobContent(Buffer.from([0x00, 0xff, 0x10, 0x00, 0x2a])), VECTORS.binary);
    });

    it("returns 64-char lowercase hex", () => {
        const hash = hashBlobContent(Buffer.from("anything"));
        assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it("is deterministic — identical content always produces the same hash (dedup guarantee)", () => {
        const a = hashBlobContent(Buffer.from("same content"));
        const b = hashBlobContent(Buffer.from("same content"));
        assert.equal(a, b);
    });

    it("any content change produces a different hash", () => {
        assert.notEqual(
            hashBlobContent(Buffer.from("hello world")),
            hashBlobContent(Buffer.from("hello world!")),
        );
    });

    it("is type-tagged — differs from a plain SHA-256 of the content", () => {
        const content = Buffer.from("hello world");
        const plain = crypto.createHash("sha256").update(content).digest("hex");
        assert.notEqual(hashBlobContent(content), plain);
    });

    it("matches the spec input built independently, byte by byte", () => {
        // Recompute the spec formula from scratch ("blob" NUL "2" NUL "hi"),
        // so a future refactor of hashBlobContent can't silently drift from it.
        const content = Buffer.from("hi", "ascii");
        const specInput = Buffer.concat([
            Buffer.from("blob", "ascii"),
            NUL,
            Buffer.from("2", "ascii"),
            NUL,
            content,
        ]);
        const expected = crypto.createHash("sha256").update(specInput).digest("hex");
        assert.equal(hashBlobContent(content), expected);
    });
});

describe("hashBlob (Web Blob wrapper)", () => {
    it("produces the same hash as hashBlobContent for the same bytes", async () => {
        const blob = new Blob([Buffer.from("hello world")]);
        assert.equal(await hashBlob(blob), VECTORS.helloWorld);
    });

    it("handles an empty Blob", async () => {
        assert.equal(await hashBlob(new Blob([])), VECTORS.empty);
    });

    it("preserves binary content end-to-end", async () => {
        const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x2a]);
        const blob = new Blob([bytes]);
        assert.equal(await hashBlob(blob), VECTORS.binary);
    });
});

// ─── Commit hashing (spec §5) ────────────────────────────────────────────────

const TREE_HASH = "8a7f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a";
const PARENT_A = "3c9d1e2f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d";
const PARENT_B = "1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777000088889999";

const AYUSH = { name: "Ayush", email: "ayush@example.com" };

function baseInput(overrides: Partial<CommitHashInput> = {}): CommitHashInput {
    return {
        rootTree: TREE_HASH,
        parents: [],
        author: AYUSH,
        timestamp: 1743264000,
        timezone: "+0530",
        message: "initial commit: project scaffold",
        ...overrides,
    };
}

// Independent reimplementation of the spec formula, byte by byte —
// SHA256("commit" NUL <byte_length> NUL <content>) — so the production code
// can't drift from the spec without a test failing.
function specCommitHash(content: string): string {
    const contentBytes = Buffer.from(content, "utf8");
    const input = Buffer.concat([
        Buffer.from("commit", "ascii"),
        NUL,
        Buffer.from(String(contentBytes.length), "ascii"),
        NUL,
        contentBytes,
    ]);
    return crypto.createHash("sha256").update(input).digest("hex");
}

describe("buildCommitContent", () => {
    it("matches the spec example 1 layout — initial commit, no parent line", () => {
        const expected =
            `tree ${TREE_HASH}\n` +
            `author Ayush <ayush@example.com> 1743264000 +0530\n` +
            `committer Ayush <ayush@example.com> 1743264000 +0530\n` +
            `\n` +
            `initial commit: project scaffold`;
        assert.equal(buildCommitContent(baseInput()), expected);
    });

    it("omits the parent line entirely for the initial commit (not 'parent null')", () => {
        assert.ok(!buildCommitContent(baseInput()).includes("parent"));
    });

    it("emits exactly one parent line for a normal commit, between tree and author", () => {
        const content = buildCommitContent(baseInput({ parents: [PARENT_A] }));
        const lines = content.split("\n");
        assert.equal(lines[1], `parent ${PARENT_A}`);
        assert.equal(lines.filter((l) => l.startsWith("parent ")).length, 1);
    });

    it("emits one parent line per parent, in order, for a merge commit", () => {
        const content = buildCommitContent(baseInput({ parents: [PARENT_A, PARENT_B] }));
        const lines = content.split("\n");
        assert.equal(lines[1], `parent ${PARENT_A}`); // ours (main-line) first
        assert.equal(lines[2], `parent ${PARENT_B}`); // theirs second
    });

    it("defaults committer to author", () => {
        const content = buildCommitContent(baseInput());
        assert.ok(content.includes("author Ayush <ayush@example.com>"));
        assert.ok(content.includes("committer Ayush <ayush@example.com>"));
    });

    it("honors a distinct committer (cherry-pick compatibility)", () => {
        const content = buildCommitContent(
            baseInput({ committer: { name: "Other", email: "other@example.com" } }),
        );
        assert.ok(content.includes("author Ayush <ayush@example.com>"));
        assert.ok(content.includes("committer Other <other@example.com>"));
    });

    it("preserves a multiline message verbatim after the blank separator line", () => {
        const message = "feat: thing\n\n- detail one\n- detail two";
        const content = buildCommitContent(baseInput({ message }));
        assert.ok(content.endsWith(`\n\n${message}`));
    });
});

describe("hashCommit", () => {
    it("matches the spec formula computed independently", () => {
        const input = baseInput({ parents: [PARENT_A] });
        assert.equal(hashCommit(input), specCommitHash(buildCommitContent(input)));
    });

    it("returns 64-char lowercase hex", () => {
        assert.match(hashCommit(baseInput()), /^[0-9a-f]{64}$/);
    });

    it("uses UTF-8 byte length in the header, not string length", () => {
        const input = baseInput({ message: "déploiement réussi 🎉" });
        const content = buildCommitContent(input);
        assert.notEqual(Buffer.byteLength(content, "utf8"), content.length); // sanity
        assert.equal(hashCommit(input), specCommitHash(content));
    });

    it("parent order changes the hash — [ours, theirs] is not [theirs, ours]", () => {
        assert.notEqual(
            hashCommit(baseInput({ parents: [PARENT_A, PARENT_B] })),
            hashCommit(baseInput({ parents: [PARENT_B, PARENT_A] })),
        );
    });

    it("timestamp changes the hash — identical re-commits stay distinct (spec §5.5)", () => {
        assert.notEqual(
            hashCommit(baseInput({ timestamp: 1743264000 })),
            hashCommit(baseInput({ timestamp: 1743264001 })),
        );
    });

    it("is type-tagged — differs from a plain SHA-256 of the content", () => {
        const content = buildCommitContent(baseInput());
        const plain = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
        assert.notEqual(hashCommit(baseInput()), plain);
    });
});
