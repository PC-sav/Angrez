/**
 * tests/lint-content.test.ts
 *
 * CL-1 through CL-6 — content-integrity lint run as a vitest suite.
 * These tests run against the real pack JSON files in /content/.
 * All checks must pass before a seed step.
 */

import * as path from "path";
import { describe, it, expect } from "vitest";
import { lintPack, type LintError } from "../scripts/lint-content";
import { readFileSync } from "fs";

const CONTENT_DIR = path.join("/Users/Pratap1/angrez", "content");
const STAGE1_FILE = path.join(CONTENT_DIR, "stage-1-hello-english.json");
const STAGE2_FILE = path.join(CONTENT_DIR, "stage-2-everyday-talk.json");

function errsByCheck(errors: LintError[], check: string): LintError[] {
  return errors.filter((e) => e.check === check);
}

// ─────────────────────────────────────────────────────────────────────────────
// CL-1  No unwinnable puzzle
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-1 — No unwinnable puzzle", () => {
  it("Stage 1: every practice + mastery_check item has accept[] or open_ended", () => {
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-1")).toHaveLength(0);
  });

  it("Stage 2: every practice + mastery_check item has accept[] or open_ended", () => {
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-1")).toHaveLength(0);
  });

  it("lintPack() catches an unwinnable puzzle in a synthetic pack", () => {
    const badPack = {
      _meta: { schema_version: "0.2" },
      pack: {
        stage: 99999, version: 1, language: "hi", mastery_threshold: 0.7,
        points: { puzzle_base: 5, voice_bonus: 3, sub_stage_complete: 20,
                  sub_stage_perfect_bonus: 10, bravery_bonus: 0, daily_open: 0 },
        feedback: { celebrate_l1: [], good_effort_l1: "", almost_l1: "",
                    heard_prefix_l1: "", mic_broken_l1: "", noise_high_l1: "",
                    silence_l1: "", ready_to_listen_l1: "" },
        sub_stages: [{
          id: "99999.1",
          teach: [],
          practice: [{ id: "99999.1.p1", type: "test" }], // no accept[], no open_ended
        }],
      },
    };
    // Write to a temp file for lintPack to read
    const tmpFile = "/tmp/bad-pack-cl1-test.json";
    const fs = require("fs");
    fs.writeFileSync(tmpFile, JSON.stringify(badPack));
    const errors = lintPack(tmpFile);
    fs.unlinkSync(tmpFile);
    expect(errsByCheck(errors, "CL-1").length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-2  Mastery is attainable
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-2 — Mastery is attainable", () => {
  it("Stage 1: mastery_threshold in (0,1] and every sub-stage has ≥1 puzzle", () => {
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-2")).toHaveLength(0);
  });

  it("Stage 2: mastery_threshold in (0,1] and every sub-stage has ≥1 puzzle", () => {
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-2")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-3  Audio references resolved or flagged
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-3 — Audio references follow the audio/ convention", () => {
  it("Stage 1: all audio refs are non-empty and start with 'audio/'", () => {
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-3")).toHaveLength(0);
  });

  it("Stage 2: all audio refs are non-empty and start with 'audio/'", () => {
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-3")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-4  Devanagari + accept-list round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-4 — Devanagari strings are NFC (seed/read round-trip safe)", () => {
  it("Stage 1: all _l1 strings and accept[] entries are already NFC", () => {
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-4")).toHaveLength(0);
  });

  it("Stage 2: all _l1 strings and accept[] entries are already NFC", () => {
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-4")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-5  Schema validation (schema_version ≥ 0.2, required fields present)
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-5 — Schema validation", () => {
  it("Stage 1 (schema_version=0.2): passes schema check", () => {
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-5")).toHaveLength(0);
  });

  it("Stage 2 (schema_version=0.3): passes schema check (0.3 >= 0.2)", () => {
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-5")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-6  ID integrity — unique, ordered, no gaps
// ─────────────────────────────────────────────────────────────────────────────

describe("CL-6 — Sub-stage ID integrity", () => {
  it("Stage 1 has 8 sub-stages with IDs 1.1 through 1.8 in order", () => {
    const pack = JSON.parse(readFileSync(STAGE1_FILE, "utf-8")).pack;
    const ids: string[] = pack.sub_stages.map((ss: { id: string }) => ss.id);
    expect(ids).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8"]);
    const errors = lintPack(STAGE1_FILE);
    expect(errsByCheck(errors, "CL-6")).toHaveLength(0);
  });

  it("Stage 2 has 8 sub-stages with IDs 2.1 through 2.8 in order", () => {
    const pack = JSON.parse(readFileSync(STAGE2_FILE, "utf-8")).pack;
    const ids: string[] = pack.sub_stages.map((ss: { id: string }) => ss.id);
    expect(ids).toEqual(["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8"]);
    const errors = lintPack(STAGE2_FILE);
    expect(errsByCheck(errors, "CL-6")).toHaveLength(0);
  });

  it("lintPack() catches a duplicate sub-stage ID", () => {
    const badPack = {
      _meta: { schema_version: "0.2" },
      pack: {
        stage: 99998, version: 1, language: "hi", mastery_threshold: 0.7,
        points: { puzzle_base: 5, voice_bonus: 3, sub_stage_complete: 20,
                  sub_stage_perfect_bonus: 10, bravery_bonus: 0, daily_open: 0 },
        feedback: { celebrate_l1: [], good_effort_l1: "", almost_l1: "",
                    heard_prefix_l1: "", mic_broken_l1: "", noise_high_l1: "",
                    silence_l1: "", ready_to_listen_l1: "" },
        sub_stages: [
          { id: "99998.1", teach: [], practice: [{ id: "p1", open_ended: true }] },
          { id: "99998.1", teach: [], practice: [{ id: "p2", open_ended: true }] }, // duplicate!
        ],
      },
    };
    const tmpFile = "/tmp/bad-pack-cl6-test.json";
    const fs = require("fs");
    fs.writeFileSync(tmpFile, JSON.stringify(badPack));
    const errors = lintPack(tmpFile);
    fs.unlinkSync(tmpFile);
    expect(errsByCheck(errors, "CL-6").length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overall: both real packs pass all checks
// ─────────────────────────────────────────────────────────────────────────────

describe("Full lint — both packs pass all CL-1..CL-6 checks", () => {
  it("Stage 1 has zero lint errors", () => {
    const errors = lintPack(STAGE1_FILE);
    if (errors.length > 0) {
      console.error("Stage 1 lint errors:", errors);
    }
    expect(errors).toHaveLength(0);
  });

  it("Stage 2 has zero lint errors", () => {
    const errors = lintPack(STAGE2_FILE);
    if (errors.length > 0) {
      console.error("Stage 2 lint errors:", errors);
    }
    expect(errors).toHaveLength(0);
  });
});
