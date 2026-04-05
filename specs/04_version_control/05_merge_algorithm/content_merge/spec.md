# Feature: Content-Level Merge (Line-by-Line)

## Status: Future Feature

This is a **future enhancement** to the merge algorithm. Currently, all `EDIT_EDIT` conflicts are resolved at the whole-file level (user picks OURS, THEIRS, or uploads a manual version). This feature would add line-level three-way merge for text files, allowing non-overlapping edits to be auto-merged.

---

## 1. Overview

When both sides modified the same file with different content (`EDIT_EDIT` at the tree level), we attempt a **line-level three-way merge** before declaring a conflict. If the edits touch **different regions** of the file, they can be merged cleanly.

### 1.1 Applicable File Types (Text-Mergeable)

Content merge only applies to **plain-text, line-oriented** formats where line-level diffing is meaningful:

| Category | Extensions |
|---|---|
| Code | `.py`, `.js`, `.ts`, `.java`, `.c`, `.cpp`, `.go`, `.rs`, `.rb`, `.php`, `.swift`, `.kt`, etc. |
| Markup/Config | `.html`, `.css`, `.xml`, `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.env` |
| Documents | `.md`, `.txt`, `.rst`, `.tex`, `.log` |
| Data (flat) | `.csv`, `.tsv`, `.sql` |
| Scripts/Build | `.sh`, `.bat`, `.ps1`, `.Makefile`, `.Dockerfile`, `.gradle` |

### 1.2 Binary Files (NOT Text-Mergeable)

These formats **cannot** be line-diffed and must always fall back to whole-file conflict resolution:

| Category | Extensions | Why |
|---|---|---|
| Images | `.png`, `.jpg`, `.gif`, `.svg`, `.ico`, `.webp`, `.bmp` | Raw pixel/vector data |
| Documents | `.pdf`, `.docx`, `.pptx`, `.odt` | Compressed/structured binary containers |
| Spreadsheets | `.xlsx`, `.xls`, `.ods` | ZIP archives containing XML internally — diffing raw bytes is meaningless |
| Archives | `.zip`, `.tar`, `.gz`, `.rar`, `.7z` | Compressed binary |
| Media | `.mp3`, `.mp4`, `.wav`, `.avi`, `.mov` | Binary streams |
| Compiled | `.exe`, `.dll`, `.so`, `.class`, `.wasm`, `.o` | Machine code |
| Fonts | `.ttf`, `.otf`, `.woff` | Binary |
| Databases | `.sqlite`, `.db` | Binary format |

### 1.3 Detection Strategy

Rather than maintaining a hardcoded extension list (which will always be incomplete), use a **two-layer check**:

1. **Extension allowlist** — known text extensions get content merge
2. **Fallback: null-byte detection** — unknown extensions use `is_binary()` check (null bytes in first 8KB)
3. **Everything detected as binary** — falls back to whole-file conflict resolution (pick OURS or THEIRS)

---

## 2. Data Model Addition: Conflict Hunk

For `EDIT_EDIT` conflicts in text files, stores the **individual conflicting regions** within the file. This allows the UI to present each hunk separately and let the user resolve them one at a time.

| Field            | Type       | Description                                              |
|-----------------|------------|----------------------------------------------------------|
| id              | UUID (PK)  | Unique hunk identifier                                     |
| conflict_id     | UUID (FK)  | The merge_conflict this hunk belongs to                    |
| hunk_index      | INT        | Order of this hunk within the file (0-based)               |
| base_start      | INT        | Start line in the BASE file                                |
| base_end        | INT        | End line in the BASE file                                  |
| base_content    | TEXT       | Lines from the BASE version                                |
| ours_content    | TEXT       | Lines from the OURS version                                |
| theirs_content  | TEXT       | Lines from the THEIRS version                              |
| resolution      | ENUM       | `PENDING` / `TAKE_OURS` / `TAKE_THEIRS` / `MANUAL`        |
| resolved_content| TEXT       | The chosen content for this hunk (`NULL` until resolved)   |

**Constraints:**
- `(conflict_id, hunk_index)` must be unique.
- A merge_conflict is fully resolved only when **all its hunks** are resolved.

---

## 3. Binary File Detection

```
function is_binary(content):
    // Check for null bytes in the first 8KB
    return contains_null_byte(content[0:8192])
```

If binary:
```
return {
    has_conflicts: true,
    conflict_hunks: [{
        hunk_index: 0,
        base_start: 0, base_end: 0,
        base_content: "(binary)",
        ours_content: "(binary)",
        theirs_content: "(binary)"
    }],
    merged_content_with_markers: ours_content   // default to ours for placeholder
}
```

---

## 4. Line Diffing (Myers Algorithm)

The merge relies on computing **edit scripts** (diffs) between file versions. We use the **Myers diff algorithm** which produces a minimal set of insert/delete operations.

```
function compute_diff(source_lines, target_lines):
    // Myers diff algorithm
    // Returns a list of DiffHunk objects:
    //   DiffHunk {
    //       source_start: int,     // start line in source
    //       source_end: int,       // end line in source (exclusive)
    //       target_start: int,     // start line in target
    //       target_end: int,       // end line in target (exclusive)
    //       type: EQUAL | INSERT | DELETE | REPLACE
    //   }
    //
    // EQUAL:   source[start:end] == target[start:end] (unchanged region)
    // DELETE:  lines in source removed (target range is empty)
    // INSERT:  lines in target added (source range is empty)
    // REPLACE: lines in source replaced with different lines in target

    return myers_diff(source_lines, target_lines)
```

---

## 5. Three-Way Content Merge Algorithm

```
function content_merge(base_content, ours_content, theirs_content):

    // ──────────────────────────────────────────────
    // STEP 1: Split into lines
    // ──────────────────────────────────────────────
    base_lines   = split_lines(base_content)
    ours_lines   = split_lines(ours_content)
    theirs_lines = split_lines(theirs_content)

    // ──────────────────────────────────────────────
    // STEP 2: Compute diffs from BASE to each side
    // ──────────────────────────────────────────────
    diff_ours   = compute_diff(base_lines, ours_lines)
    diff_theirs = compute_diff(base_lines, theirs_lines)

    // ──────────────────────────────────────────────
    // STEP 3: Extract changed regions in BASE coordinates
    // ──────────────────────────────────────────────
    // Each diff hunk maps to a range of lines in the BASE file.
    // We need to find which BASE regions were modified by ours vs theirs.
    //
    // A "changed region" is any hunk that is NOT type EQUAL.

    ours_regions   = extract_changed_regions(diff_ours)     // list of (start, end)
    theirs_regions = extract_changed_regions(diff_theirs)   // list of (start, end)

    // ──────────────────────────────────────────────
    // STEP 4: Partition BASE into non-overlapping segments
    // ──────────────────────────────────────────────
    // Merge all region boundaries into a sorted list of cut points.
    // Between cut points, each segment is either:
    //   - Changed by OURS only
    //   - Changed by THEIRS only
    //   - Changed by BOTH (potential conflict)
    //   - Changed by NEITHER (take from base)

    segments = partition_into_segments(base_lines, ours_regions, theirs_regions)

    // ──────────────────────────────────────────────
    // STEP 5: Process each segment
    // ──────────────────────────────────────────────
    merged_lines = []
    conflict_hunks = []
    hunk_index = 0

    for segment in segments:

        if segment.changed_by == NEITHER:
            // No changes in this region — keep BASE lines
            merged_lines.extend(segment.base_lines)

        elif segment.changed_by == OURS_ONLY:
            // Only repo side changed this region — take ours
            merged_lines.extend(segment.ours_lines)

        elif segment.changed_by == THEIRS_ONLY:
            // Only workspace side changed this region — take theirs
            merged_lines.extend(segment.theirs_lines)

        elif segment.changed_by == BOTH:
            if segment.ours_lines == segment.theirs_lines:
                // Both sides made the SAME change — no conflict
                merged_lines.extend(segment.ours_lines)
            else:
                // CONFLICT — overlapping changes with different content
                conflict_hunks.append({
                    hunk_index:     hunk_index,
                    base_start:     segment.base_start,
                    base_end:       segment.base_end,
                    base_content:   join_lines(segment.base_lines),
                    ours_content:   join_lines(segment.ours_lines),
                    theirs_content: join_lines(segment.theirs_lines)
                })
                hunk_index += 1

                // Insert conflict markers in the merged output
                merged_lines.append("<<<<<<< REPO (ours)")
                merged_lines.extend(segment.ours_lines)
                merged_lines.append("=======")
                merged_lines.extend(segment.theirs_lines)
                merged_lines.append(">>>>>>> WORKSPACE (theirs)")

    return {
        merged_content:              join_lines(merged_lines),
        merged_content_with_markers: join_lines(merged_lines),  // same if conflicts exist
        has_conflicts:               len(conflict_hunks) > 0,
        conflict_hunks:              conflict_hunks
    }
```

---

## 6. Helpers

### 6.1 Extract Changed Regions

Converts diff hunks into BASE line ranges that were modified.

```
function extract_changed_regions(diff_hunks):
    regions = []
    for hunk in diff_hunks:
        if hunk.type != EQUAL:
            regions.append({
                base_start: hunk.source_start,
                base_end:   hunk.source_end,
                target_lines: target_lines[hunk.target_start : hunk.target_end]
            })
    return regions
```

### 6.2 Partition into Segments

Takes the BASE file and both sides' changed regions, and produces non-overlapping segments annotated with who changed them.

```
function partition_into_segments(base_lines, ours_regions, theirs_regions):
    // Collect all boundary points
    boundaries = sorted_unique([0, len(base_lines)]
        + [r.base_start for r in ours_regions]
        + [r.base_end   for r in ours_regions]
        + [r.base_start for r in theirs_regions]
        + [r.base_end   for r in theirs_regions]
    )

    segments = []
    for i in range(len(boundaries) - 1):
        seg_start = boundaries[i]
        seg_end   = boundaries[i + 1]

        if seg_start == seg_end:
            continue    // zero-width segment

        ours_changed   = any(region overlaps [seg_start, seg_end) for region in ours_regions)
        theirs_changed = any(region overlaps [seg_start, seg_end) for region in theirs_regions)

        segment = {
            base_start:  seg_start,
            base_end:    seg_end,
            base_lines:  base_lines[seg_start : seg_end],
            ours_lines:  resolve_lines_for_side(seg_start, seg_end, ours_regions, ours_lines),
            theirs_lines: resolve_lines_for_side(seg_start, seg_end, theirs_regions, theirs_lines),
        }

        if ours_changed and theirs_changed:
            segment.changed_by = BOTH
        elif ours_changed:
            segment.changed_by = OURS_ONLY
        elif theirs_changed:
            segment.changed_by = THEIRS_ONLY
        else:
            segment.changed_by = NEITHER

        segments.append(segment)

    return segments
```

### 6.3 Resolve Lines for Side

Given a BASE range and a side's diff regions, returns what that range looks like in the side's version.

```
function resolve_lines_for_side(seg_start, seg_end, regions, full_side_lines):
    // Find the region that covers this segment
    for region in regions:
        if region.base_start <= seg_start and region.base_end >= seg_end:
            // This region covers our segment — return the target lines
            // Compute offset within the region
            return region.target_lines  // the replacement lines from this side

    // No region covers this segment — it wasn't changed, return base lines
    return base_lines[seg_start : seg_end]
```

---

## 7. Walkthrough: Content Merge with Partial Conflict

### 7.1 BASE File (10 lines)

```
Line 1:  import os
Line 2:  import sys
Line 3:
Line 4:  def connect():
Line 5:      host = "localhost"
Line 6:      port = 3000
Line 7:      return create_connection(host, port)
Line 8:
Line 9:  def disconnect():
Line 10:     close_all()
```

### 7.2 OURS (Repo HEAD) — changed port and added timeout

```
Line 1:  import os
Line 2:  import sys
Line 3:
Line 4:  def connect():
Line 5:      host = "localhost"
Line 6:      port = 8080                          <- MODIFIED (was 3000)
Line 7:      timeout = 30                          <- ADDED
Line 8:      return create_connection(host, port, timeout)  <- MODIFIED
Line 9:
Line 10: def disconnect():
Line 11:     close_all()
```

### 7.3 THEIRS (Workspace HEAD) — changed port and modified disconnect

```
Line 1:  import os
Line 2:  import sys
Line 3:
Line 4:  def connect():
Line 5:      host = "localhost"
Line 6:      port = 5432                           <- MODIFIED (was 3000)
Line 7:      return create_connection(host, port)
Line 8:
Line 9:  def disconnect():
Line 10:     cleanup_resources()                    <- MODIFIED (was close_all)
Line 11:     close_all()
```

### 7.4 Diff Analysis

```
diff(BASE -> OURS):
  Region A: lines 6-7 in BASE -> replaced with 3 lines (port=8080, timeout=30, new return)
    BASE  [6:8) -> "port = 3000", "return create_connection(host, port)"
    OURS         -> "port = 8080", "timeout = 30", "return create_connection(host, port, timeout)"

diff(BASE -> THEIRS):
  Region B: line 6 in BASE -> replaced
    BASE  [6:7) -> "port = 3000"
    THEIRS       -> "port = 5432"

  Region C: line 10 in BASE -> replaced with 2 lines
    BASE  [10:11) -> "close_all()"
    THEIRS         -> "cleanup_resources()", "close_all()"
```

### 7.5 Segment Partitioning

```
Boundaries: [0, 6, 7, 8, 10, 11]

Segment 1: lines [0, 6)  -> NEITHER changed    -> take base (lines 1-5)
Segment 2: lines [6, 7)  -> BOTH changed       -> ours="port=8080", theirs="port=5432" -> CONFLICT
Segment 3: lines [7, 8)  -> OURS_ONLY changed  -> take ours (timeout + new return)
Segment 4: lines [8, 10) -> NEITHER changed    -> take base (blank line + disconnect def)
Segment 5: lines [10,11) -> THEIRS_ONLY changed -> take theirs (cleanup_resources + close_all)
```

### 7.6 Merged Result

```
import os
import sys

def connect():
    host = "localhost"
<<<<<<< REPO (ours)
    port = 8080
=======
    port = 5432
>>>>>>> WORKSPACE (theirs)
    timeout = 30
    return create_connection(host, port, timeout)

def disconnect():
    cleanup_resources()
    close_all()
```

- Lines 1-5: clean (no changes)
- Line 6 (port): **CONFLICT** — ours says 8080, theirs says 5432
- Lines 7-8 (timeout + return): clean from ours only
- Lines 9-10: clean (no changes)
- Line 11 (disconnect body): clean from theirs only

**1 conflict hunk** stored, everything else auto-merged.

---

## 8. Hunk-Level Resolution API

### 8.1 Resolve a Hunk (EDIT_EDIT)

```
POST /merges/{merge_state_id}/conflicts/{conflict_id}/hunks/{hunk_index}/resolve

Body:
{
    "resolution": "TAKE_OURS" | "TAKE_THEIRS" | "MANUAL",
    "content": "..."    // required only for MANUAL
}
```

**Algorithm:**

```
function resolve_hunk(conflict_id, hunk_index, resolution, manual_content):
    hunk = load_hunk(conflict_id, hunk_index)

    if resolution == "TAKE_OURS":
        resolved = hunk.ours_content
    elif resolution == "TAKE_THEIRS":
        resolved = hunk.theirs_content
    elif resolution == "MANUAL":
        resolved = manual_content

    UPDATE conflict_hunk SET
        resolution = resolution,
        resolved_content = resolved
    WHERE conflict_id = conflict_id AND hunk_index = hunk_index

    // Check if all hunks for this conflict are resolved
    check_conflict_fully_resolved(conflict_id)
```

### 8.2 Build Resolved File from Hunks

When all hunks in an EDIT_EDIT conflict are resolved, rebuild the file:

```
function build_resolved_file(conflict_id):
    conflict = load_conflict(conflict_id)
    hunks = SELECT * FROM conflict_hunk
            WHERE conflict_id = conflict_id
            ORDER BY hunk_index

    // Start with the auto-merged content and replace conflict regions
    // with resolved content
    base_lines = split_lines(load_blob_content(conflict.base_blob))
    ours_lines = split_lines(load_blob_content(conflict.ours_blob))
    theirs_lines = split_lines(load_blob_content(conflict.theirs_blob))

    // Re-run the merge but use resolved content for conflict regions
    result = content_merge_with_resolutions(base_lines, ours_lines, theirs_lines, hunks)

    // Create new blob with resolved content
    resolved_blob = create_blob(result)

    UPDATE merge_conflict SET
        resolved_blob = resolved_blob.hash,
        resolution = "MANUAL",    // or derive from hunk resolutions
        resolved_at = now()
    WHERE id = conflict_id
```

---

## 9. Integration Points

When this feature is implemented, the following changes are needed in the main merge spec (`spec.md`):

1. **Section 4.1**: Restore the `CONTENT_MERGE` action type — when both sides modified the same file, attempt `content_merge()` before falling back to whole-file conflict.
2. **Section 4.3**: Change `EDIT_EDIT` from returning `CONFLICT` to returning `CONTENT_MERGE`.
3. **Section 3**: Add the Conflict Hunk table back to the data model.
4. **Section 7.1**: Restore hunk storage logic in the orchestrator.
5. **Section 8**: Add hunk-level resolution endpoints alongside whole-file resolution.
6. **Section 9**: Update EDIT_EDIT resolution options to include per-hunk resolution.
