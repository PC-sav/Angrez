#!/usr/bin/env ts-node
/**
 * scripts/lint-content.ts
 *
 * Content-integrity lint — run over both stage packs before every seed.
 * CL-1: No unwinnable puzzle (every scored item has accept[] or open_ended=true).
 * CL-2: Mastery is attainable (threshold in (0,1], at least 1 puzzle per sub-stage).
 * CL-3: Audio references are non-empty and follow the audio/ convention.
 * CL-4: Devanagari strings are already in NFC (round-trip safe).
 * CL-5: Schema_version ≥ 0.2 and required fields present on each sub_stage.
 * CL-6: Sub-stage IDs are unique and sequentially ordered within the pack.
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PuzzleItem {
  id: string;
  type?: string;
  accept?: string[];
  accept_frames?: string[];
  open_ended?: boolean;
  audio?: string;
  [key: string]: unknown;
}

interface SubStage {
  id: string;
  warmup?: Record<string, unknown>;
  teach?: unknown[];
  practice?: PuzzleItem[];
  mastery_check?: PuzzleItem[];
  recap?: unknown[];
  [key: string]: unknown;
}

interface PackPoints {
  puzzle_base: number;
  voice_bonus: number;
  sub_stage_complete: number;
  sub_stage_perfect_bonus: number;
  [key: string]: number;
}

interface Pack {
  stage: number;
  version: number;
  language: string;
  mastery_threshold: number;
  points: PackPoints;
  feedback: Record<string, unknown>;
  sub_stages: SubStage[];
  [key: string]: unknown;
}

interface PackFile {
  _meta?: { schema_version: string };
  pack: Pack;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectL1Strings(obj: unknown, results: string[] = []): string[] {
  if (typeof obj === "string") {
    results.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectL1Strings(item, results);
  } else if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key.endsWith("_l1") || key === "accept") {
        collectL1Strings(val, results);
      }
    }
  }
  return results;
}

function collectAudioRefs(obj: unknown, results: string[] = []): string[] {
  if (Array.isArray(obj)) {
    for (const item of obj) collectAudioRefs(item, results);
  } else if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "audio") {
        if (typeof val === "string") results.push(val);
      } else {
        collectAudioRefs(val, results);
      }
    }
  }
  return results;
}

// ── Lint checks ───────────────────────────────────────────────────────────────

export interface LintError {
  check: string;
  file: string;
  substage?: string;
  item?: string;
  message: string;
}

export function lintPack(file: string): LintError[] {
  const errors: LintError[] = [];
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as PackFile;
  const pack = raw.pack;
  const schemaVersion = raw._meta?.schema_version ?? "unknown";
  const filename = path.basename(file);

  function err(check: string, message: string, substage?: string, item?: string): void {
    errors.push({ check, file: filename, substage, item, message });
  }

  // CL-5: schema_version present and >= 0.2
  const [major, minor] = (schemaVersion === "unknown" ? "0.0" : schemaVersion)
    .split(".")
    .map(Number);
  if (major < 0 || (major === 0 && minor < 2)) {
    err("CL-5", `schema_version must be >= 0.2, got: ${schemaVersion}`);
  }

  // CL-5: required top-level pack fields
  for (const field of ["stage", "version", "language", "mastery_threshold", "points", "sub_stages"]) {
    if (!(field in pack)) {
      err("CL-5", `Missing required top-level field: ${field}`);
    }
  }

  // CL-2: mastery_threshold in (0, 1]
  if (typeof pack.mastery_threshold === "number") {
    if (pack.mastery_threshold <= 0 || pack.mastery_threshold > 1) {
      err("CL-2", `mastery_threshold must be in (0, 1], got: ${pack.mastery_threshold}`);
    }
  }

  const seenIds = new Set<string>();
  const expectedPrefix = String(pack.stage);

  for (let ssIdx = 0; ssIdx < pack.sub_stages.length; ssIdx++) {
    const ss = pack.sub_stages[ssIdx];
    const ssId = ss.id ?? `[index ${ssIdx}]`;

    // CL-6: sub-stage ID uniqueness
    if (seenIds.has(ssId)) {
      err("CL-6", `Duplicate sub-stage id: ${ssId}`, ssId);
    }
    seenIds.add(ssId);

    // CL-6: ID ordering — each ID should be "{stage}.{1..N}" in order
    const parts = ssId.split(".");
    if (parts[0] !== expectedPrefix) {
      err("CL-6", `Sub-stage id "${ssId}" doesn't start with stage prefix "${expectedPrefix}"`, ssId);
    }
    const seqNum = parseInt(parts[1] ?? "", 10);
    if (isNaN(seqNum) || seqNum !== ssIdx + 1) {
      err("CL-6", `Sub-stage id "${ssId}" expected sequence number ${ssIdx + 1}, got: ${parts[1]}`, ssId);
    }

    // CL-5: required sub-stage fields
    for (const field of ["id", "teach", "practice"]) {
      if (!(field in ss)) {
        err("CL-5", `Sub-stage missing required field: ${field}`, ssId);
      }
    }

    // CL-2: at least one scorable puzzle per sub-stage
    const allPuzzles = [...(ss.practice ?? []), ...(ss.mastery_check ?? [])];
    if (allPuzzles.length === 0) {
      err("CL-2", `Sub-stage has no practice or mastery_check puzzles`, ssId);
    }

    for (const puzzle of allPuzzles) {
      const pId = puzzle.id ?? "[no id]";

      // CL-1: no unwinnable puzzle
      const hasAccept = (puzzle.accept?.length ?? 0) > 0 || (puzzle.accept_frames?.length ?? 0) > 0;
      const hasOpenEnded = !!puzzle.open_ended;
      if (!hasAccept && !hasOpenEnded) {
        err("CL-1", `Puzzle has neither accept[] nor open_ended — unwinnable`, ssId, pId);
      }
    }
  }

  // CL-6: no gaps — IDs should be 1, 2, ..., N
  // (already checked above via seqNum === ssIdx + 1)

  // CL-3: audio references non-empty and follow convention
  const audioRefs = collectAudioRefs(pack);
  for (const ref of audioRefs) {
    if (!ref || ref.trim() === "") {
      err("CL-3", `Empty audio reference found`);
    } else if (!ref.startsWith("audio/") && !ref.includes("pending")) {
      err("CL-3", `Audio ref doesn't follow audio/ convention and isn't marked pending: ${ref}`);
    }
  }

  // CL-4: Devanagari strings already in NFC
  const l1Strings = collectL1Strings(pack);
  for (const s of l1Strings) {
    if (s !== s.normalize("NFC")) {
      err("CL-4", `String is not in NFC form: "${s.slice(0, 40)}…"`);
    }
  }

  return errors;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const contentDir = path.join(__dirname, "..", "content");
  const packFiles = fs.readdirSync(contentDir).filter((f) => f.endsWith(".json"));

  if (packFiles.length === 0) {
    console.error("No content pack JSON files found in", contentDir);
    process.exit(1);
  }

  let totalErrors = 0;
  for (const file of packFiles) {
    const errors = lintPack(path.join(contentDir, file));
    if (errors.length === 0) {
      console.log(`✓  ${file}`);
    } else {
      for (const e of errors) {
        const loc = [e.substage, e.item].filter(Boolean).join(" / ");
        console.error(`✗  [${e.check}] ${e.file}${loc ? ` (${loc})` : ""}: ${e.message}`);
      }
      totalErrors += errors.length;
    }
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} lint error(s) found. Fix before seeding.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${packFiles.length} pack(s) passed lint.`);
  }
}
