/**
 * tests/matcher.test.ts
 *
 * Unit tests for src/services/matcher.ts.
 * Pure module — no DB, no HTTP, no env required.
 */

import { describe, it, expect } from "vitest";
import { matchAnswer, normalise, type Puzzle } from "../src/services/matcher";

// ─────────────────────────────────────────────────────────────────────────────
// normalise()
// ─────────────────────────────────────────────────────────────────────────────

describe("normalise()", () => {
  it("lowercases", () => expect(normalise("ALL GOOD")).toBe("all good"));

  it("strips apostrophes", () =>
    expect(normalise("I'm good")).toBe("im good"));

  it("strips curly apostrophes", () =>
    expect(normalise("I’m fine")).toBe("im fine"));

  it("strips full-stop, comma, question mark, exclamation mark", () =>
    expect(normalise("Yes, I'm fine! Really?")).toBe("yes im fine really"));

  it("collapses multiple spaces", () =>
    expect(normalise("  all   good  ")).toBe("all good"));

  it("handles empty string", () => expect(normalise("")).toBe(""));

  it("strips ellipsis and dashes", () =>
    expect(normalise("well… I don’t know—really")).toBe(
      "well i dont knowreally",
    ));
});

// ─────────────────────────────────────────────────────────────────────────────
// mode: 'accept'
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — mode: accept", () => {
  const puzzle: Puzzle = { accept: ["I'm good thank you", "im good thank you"] };

  it("exact match passes", () => {
    const r = matchAnswer(puzzle, "I'm good thank you");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("accept");
  });

  it("match is case-insensitive", () => {
    const r = matchAnswer(puzzle, "i'm good thank you");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("trailing punctuation is stripped before comparison", () => {
    const r = matchAnswer(puzzle, "I'm good, thank you!");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("apostrophe variant matches the normalised form", () => {
    const r = matchAnswer(puzzle, "Im good thank you");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("no match returns pass=false", () => {
    const r = matchAnswer(puzzle, "not in the list at all");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
    expect(r.mode).toBe("accept");
  });

  it("empty transcript fails", () => {
    const r = matchAnswer(puzzle, "   ");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mode: 'frame'
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — mode: frame", () => {
  const puzzle: Puzzle = {
    accept_frames: ["my name is *", "i'm *", "i am *", "myself *"],
  };

  it("frame pass — content after prefix", () => {
    const r = matchAnswer(puzzle, "My name is Riya");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("frame");
  });

  it("frame pass — apostrophe frame normalised", () => {
    const r = matchAnswer(puzzle, "I'm Pratap");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("frame pass — 'i am' frame", () => {
    const r = matchAnswer(puzzle, "I am Ananya");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("frame fail — prefix only with no name after it", () => {
    const r = matchAnswer(puzzle, "My name is");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });

  it("frame fail — trailing whitespace only after prefix", () => {
    const r = matchAnswer(puzzle, "My name is   ");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });

  it("frame fail — wrong prefix entirely", () => {
    const r = matchAnswer(puzzle, "hello Riya");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });

  it("frame fail — shares leading letters but not a real prefix match", () => {
    // "image" starts with "im" but is NOT "im " (i'm prefix)
    const r = matchAnswer(puzzle, "image is nice");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });

  it("empty transcript fails", () => {
    const r = matchAnswer(puzzle, "");
    expect(r.pass).toBe(false);
    expect(r.mode).toBe("frame");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mode: 'open_ended'
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — mode: open_ended (no hints)", () => {
  const puzzle: Puzzle = { open_ended: true };

  it("any non-empty transcript passes", () => {
    const r = matchAnswer(puzzle, "anything at all");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("open_ended");
  });

  it("single word passes", () => {
    const r = matchAnswer(puzzle, "yes");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("whitespace-only transcript fails", () => {
    const r = matchAnswer(puzzle, "   ");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
    expect(r.mode).toBe("open_ended");
  });

  it("empty string fails", () => {
    const r = matchAnswer(puzzle, "");
    expect(r.pass).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mode: 'open_ended_with_hints'
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — mode: open_ended_with_hints (accept[])", () => {
  const puzzle: Puzzle = {
    open_ended: true,
    accept: ["I'm good", "im good", "good", "fine"],
  };

  it("pass=true even when transcript does not match accept[]", () => {
    const r = matchAnswer(puzzle, "whatever man sure");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(false);
    expect(r.mode).toBe("open_ended_with_hints");
  });

  it("pass=true AND matched=true when transcript matches accept[]", () => {
    const r = matchAnswer(puzzle, "I'm good");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("open_ended_with_hints");
  });

  it("empty transcript fails even though open_ended=true", () => {
    const r = matchAnswer(puzzle, "");
    expect(r.pass).toBe(false);
    expect(r.matched).toBe(false);
  });
});

describe("matchAnswer — mode: open_ended_with_hints (accept_frames[])", () => {
  const puzzle: Puzzle = {
    open_ended: true,
    accept_frames: ["my name is *", "i am *", "i'm *"],
  };

  it("pass=true and matched=true when frame matches", () => {
    const r = matchAnswer(puzzle, "My name is Riya");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("open_ended_with_hints");
  });

  it("pass=true but matched=false when transcript is random chatter", () => {
    const r = matchAnswer(puzzle, "just some random words here");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(false);
    expect(r.mode).toBe("open_ended_with_hints");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mode: 'fallback'  — content gap
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — mode: fallback (no rules defined)", () => {
  const puzzle: Puzzle = {};

  it("flags mode as fallback with non-empty transcript", () => {
    const r = matchAnswer(puzzle, "hello there");
    expect(r.mode).toBe("fallback");
  });

  it("passes (fail-safe) for non-empty transcript", () => {
    const r = matchAnswer(puzzle, "hello there");
    expect(r.pass).toBe(true);
    expect(r.matched).toBe(false);
  });

  it("fails on empty transcript", () => {
    const r = matchAnswer(puzzle, "");
    expect(r.pass).toBe(false);
    expect(r.mode).toBe("fallback");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty transcript fails everywhere (cross-mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("empty transcript always fails", () => {
  const cases: Array<[string, Puzzle]> = [
    ["accept", { accept: ["yes"] }],
    ["frame", { accept_frames: ["my name is *"] }],
    ["open_ended", { open_ended: true }],
    ["open_ended_with_hints", { open_ended: true, accept: ["yes"] }],
    ["fallback", {}],
  ];

  for (const [label, puzzle] of cases) {
    it(`mode '${label}' — empty transcript → pass=false`, () => {
      expect(matchAnswer(puzzle, "").pass).toBe(false);
      expect(matchAnswer(puzzle, "   ").pass).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Invalid inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("matchAnswer — invalid inputs", () => {
  it("throws TypeError when transcript is not a string", () => {
    expect(() =>
      matchAnswer({ accept: ["yes"] }, null as unknown as string),
    ).toThrow(TypeError);
  });
});
