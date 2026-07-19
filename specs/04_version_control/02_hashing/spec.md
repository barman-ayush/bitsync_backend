# 02_hashing — Hashing Specification

This specification details the cryptographic hashing formulas and integrity verification procedures in BitSync.

## 1. Hash Function: SHA-256

All object identities and validation schemes in BitSync use **SHA-256** (returning a 64-character lowercase hex string). The output hashes are content-addressed: any change to an object's contents changes its identifier.

---

## 2. Object Hash Formulas

### 2.1 Blob Hash
Stores the raw contents of a file. The hash is computed over a type header, size prefix, and the content bytes:
```
BLOB_HASH = SHA256( "blob" + "\0" + size_in_decimal_ascii + "\0" + file_bytes )
```

### 2.2 Tree Hash
Represents a directory directory. The tree hash is computed recursively using a Merkle tree model:
1. For each immediate child entry, create a string: `"<type> <name>\0<object_hash>"`, where `<type>` is `"blob"` or `"tree"`.
2. Sort all child strings lexicographically by name to ensure determinism.
3. Concatenate all sorted child strings.
4. Hash the combined sequence with a type header:
```
TREE_HASH = SHA256( "tree" + "\0" + concatenated_sorted_child_strings )
```

### 2.3 Commit Hash
A snapshot of the repository directory hierarchy. The hash is computed over a formatted header and content details:
1. Build the commit body content string:
```
tree <root_tree_hash>\n
parent <parent_hash_1>\n
parent <parent_hash_2>\n
author <name> <email> <unix_timestamp> <timezone>\n
committer <name> <email> <unix_timestamp> <timezone>\n
\n
<message>
```
2. Hash the body string with the type and size prefix:
```
COMMIT_HASH = SHA256( "commit" + "\0" + byte_length_of_body + "\0" + body )
```

---

## 3. Pull Request Fingerprinting

Because Pull Requests are mutable entities, they do not have a single content-addressed hash during their lifecycle. However, when a PR is merged, the merge state is permanently snapshotted using three commits:
- `baseCommit`: The computed common ancestor of the repository and workspace at merge time.
- `headCommit`: The workspace HEAD commit.
- `mergeCommit`: The resulting merge commit created on the repository's main line.

These three references together form a deterministic **PR Fingerprint**:
```
PR_FINGERPRINT = SHA256( "pr" + "\0" + base_commit_hash + "\0" + head_commit_hash + "\0" + merge_commit_hash )
```

---

## 4. Integrity Verification

The content-addressed object model enables full cryptographic verification of the repository's status:

- **Blob Verification**: Recomputes the blob hash formula over the stored bytes to verify it matches the stored primary key hash.
- **Tree Verification**: Loads the child entries, sorts them by name, reconstructs the Merkle child entries block, hashes it, and checks it matches the parent directory's hash record.
- **Commit Verification**: Rebuilds the commit content header, hashes it, and verifies it matches the commit hash primary key.
- **Repository Verification**: Walks back through the entire commit DAG starting from the repository's HEAD. For each commit encountered, it recursively verifies the commit hash, verifies its Merkle tree structure (evaluating all child trees and file blobs), and continues back along all merge parents.

---

## 5. Key Invariants

1. **Content Addressability**: Recomputing an object's hash from its content must match its identifier.
2. **Deduplication**: Identical files produce identical hashes and are stored only once.
3. **Collision Resistance**: Prefixes like `"blob\0"`, `"tree\0"`, and `"commit\0"` prevent cross-type collisions.
4. **DAG Verification**: Verifying the HEAD commit hash implicitly proves the integrity of all historical parents, commits, and directories reachable from it.
