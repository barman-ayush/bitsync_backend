# Feature: Content-Level Merge (Line-by-Line)

## Status: Future Feature

This specification details a future enhancement to support line-level three-way merges for text files to auto-resolve non-overlapping edits.

---

## 1. Overview

Currently, all `EDIT_EDIT` conflicts are resolved at the whole-file level. The content-level merge feature introduces line-by-line diffing for plain-text files (such as `.py`, `.ts`, `.html`, `.md`, etc.) to auto-resolve changes that occur in different regions of the file.

Binary formats (like `.png`, `.pdf`, `.zip`, etc.) are detected and skipped, falling back immediately to whole-file conflict resolution.

---

## 2. Proposed Data Model: Conflict Hunks

For text conflicts, individual conflicting regions (hunks) are stored in the database:
- `id` (UUID, Primary Key)
- `conflictId` (UUID, Foreign Key referencing Merge Conflict)
- `hunkIndex` (integer, order of the hunk within the file)
- `baseStart` & `baseEnd` (line numbers in the BASE file)
- `baseContent`, `oursContent`, `theirsContent` (strings storing the line contents of each version)
- `resolution` (enum: `'PENDING'`, `'TAKE_OURS'`, `'TAKE_THEIRS'`, `'MANUAL'`)
- `resolvedContent` (string, nullable)

---

## 3. Algorithm Strategy

1. **Binary Detection**: Checks for null bytes in the first 8 KB of the file. If detected, the file is treated as binary and falls back to whole-file resolution.
2. **Myers Diffing**: Computes line-by-line edits (inserts/deletions) between `BASE` and `OURS`, and `BASE` and `THEIRS`.
3. **Three-Way Merge Resolution**:
   - Compares edit blocks from both sides.
   - If only one side modified a line range, that change is automatically integrated.
   - If both sides modified the same line range with different contents, a conflict hunk is generated.
   - Outputs a merged file containing conflict hunks and markers.
4. **Hunk-Level Resolution**: The user can resolve individual conflict hunks independently in the UI. A file is marked resolved when all its constituent hunks have been resolved.
