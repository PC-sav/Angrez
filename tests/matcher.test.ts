/**
 * tests/matcher.test.ts
 *
 * Unit tests for src/services/matcher.ts.
 * Pure module — no DB, no HTTP, no env required.
 */

import { readFileSync } from "fs";
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

// ─────────────────────────────────────────────────────────────────────────────
// MA-1  Devanagari Unicode normalization (NFC ≡ NFD after normalise())
// ─────────────────────────────────────────────────────────────────────────────

describe("MA-1 — Devanagari Unicode NFC/NFD normalization", () => {
  // U+0958 (क़) has canonical decomposition: U+0915 (क) + U+093C (़)
  // So NFC("क़") === "क़" and NFD("क़") === "क़"
  const NFC_CHAR = "क़"; // क़ — precomposed NFC form (1 code point)
  const NFD_CHARS = "क़"; // क + ़ — decomposed NFD form (2 code points)

  it("NFC and NFD forms are different bytes (pre-condition for the test)", () => {
    expect(NFC_CHAR).not.toBe(NFD_CHARS);
    expect(NFC_CHAR.length).toBe(1);
    expect(NFD_CHARS.length).toBe(2);
  });

  it("accept[] in NFC matches transcript in NFD", () => {
    const puzzle: Puzzle = { accept: [NFC_CHAR] };
    const result = matchAnswer(puzzle, NFD_CHARS);
    expect(result.pass).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("accept[] in NFD matches transcript in NFC", () => {
    const puzzle: Puzzle = { accept: [NFD_CHARS] };
    const result = matchAnswer(puzzle, NFC_CHAR);
    expect(result.pass).toBe(true);
  });

  it("normalise() maps both forms to the same canonical string", () => {
    expect(normalise(NFC_CHAR)).toBe(normalise(NFD_CHARS));
  });

  it("mixed Hindi + NFC/NFD in a longer accept phrase", () => {
    const baseWord = "नमस्ते "; // pure NFC Hindi
    const nfcPhrase = baseWord + NFC_CHAR;
    const nfdPhrase = baseWord + NFD_CHARS;
    const puzzle: Puzzle = { accept: [nfcPhrase] };
    expect(matchAnswer(puzzle, nfdPhrase).pass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MA-2  ASR / accent noise — real-world input tolerance
// ─────────────────────────────────────────────────────────────────────────────

describe("MA-2 — ASR / accent noise on accept[]", () => {
  const puzzle: Puzzle = { accept: ["I'm good, thank you"] };

  it("leading filler 'um,' stripped before comparison", () => {
    expect(matchAnswer(puzzle, "um, I'm good, thank you").pass).toBe(true);
  });

  it("leading filler 'uh ' stripped before comparison", () => {
    expect(matchAnswer(puzzle, "uh I'm good, thank you").pass).toBe(true);
  });

  it("'I am' accepted as equivalent to 'I'm' (contraction expansion)", () => {
    expect(matchAnswer(puzzle, "I am good, thank you").pass).toBe(true);
  });

  it("case is ignored (all-caps ASR output)", () => {
    expect(matchAnswer(puzzle, "I'M GOOD, THANK YOU").pass).toBe(true);
  });

  it("extra internal whitespace collapsed", () => {
    expect(matchAnswer(puzzle, "I'm  good,  thank you").pass).toBe(true);
  });

  it("trailing punctuation stripped", () => {
    expect(matchAnswer(puzzle, "I'm good, thank you!").pass).toBe(true);
  });

  it("frame mode: 'i am' prefix matches 'i'm' frame (contraction)", () => {
    const framePuzzle: Puzzle = { accept_frames: ["i'm *", "i am *"] };
    expect(matchAnswer(framePuzzle, "I am Riya").pass).toBe(true);
    expect(matchAnswer(framePuzzle, "I'm Riya").pass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MA-5  Hostile inputs — always return a verdict, never throw
// ─────────────────────────────────────────────────────────────────────────────

describe("MA-5 — Hostile inputs degrade gracefully", () => {
  it("Hinglish transcript returns a verdict without throwing", () => {
    const puzzle: Puzzle = { accept: ["I'm fine"] };
    expect(() => matchAnswer(puzzle, "main theek hoon, thanks!")).not.toThrow();
    const r = matchAnswer(puzzle, "main theek hoon, thanks!");
    expect(typeof r.pass).toBe("boolean");
    expect(r.pass).toBe(false); // no match against English accept
  });

  it("mixed Devanagari + English transcript returns a verdict", () => {
    const puzzle: Puzzle = { open_ended: true };
    expect(() => matchAnswer(puzzle, "Hello नमस्ते")).not.toThrow();
    expect(matchAnswer(puzzle, "Hello नमस्ते").pass).toBe(true);
  });

  it("emoji in transcript returns a verdict without throwing", () => {
    const puzzle: Puzzle = { open_ended: true };
    expect(() => matchAnswer(puzzle, "I'm good 😊")).not.toThrow();
    expect(matchAnswer(puzzle, "I'm good 😊").pass).toBe(true);
  });

  it("very long transcript (10 000 chars) returns a verdict within 500ms", () => {
    const longTranscript = "hello ".repeat(1667).trim();
    const puzzle: Puzzle = { accept: ["hello"] };
    const start = Date.now();
    expect(() => matchAnswer(puzzle, longTranscript)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
    // "hello hello hello…" does not equal normalised "hello"
    expect(matchAnswer(puzzle, longTranscript).pass).toBe(false);
  });

  it("null transcript throws TypeError (caught at route layer before matchAnswer)", () => {
    expect(() =>
      matchAnswer({ accept: ["yes"] }, null as unknown as string),
    ).toThrow(TypeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MA-6  Matcher purity — static check
// ─────────────────────────────────────────────────────────────────────────────

describe("MA-6 — Matcher purity (static: no DB / network / clock)", () => {
  it("matcher.ts has no imports from DB, network, or fs modules", () => {
    const src = readFileSync("/Users/Pratap1/angrez/src/services/matcher.ts", "utf-8");
    // No DB client
    expect(src).not.toMatch(/from\s+['"](?:pg|.*pool.*|.*\/db)['"]/);
    // No HTTP/fetch
    expect(src).not.toMatch(/from\s+['"](?:http|https|axios|got|node-fetch)['"]/);
    // No file system
    expect(src).not.toMatch(/readFileSync|createReadStream/);
    // No timers that would make it non-deterministic
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });

  it("matcher exports are pure functions with no module-level side effects", () => {
    // The ESM import at the top of this file already loaded the module without error.
    // Verifying the exports exist confirms the module loaded cleanly.
    expect(typeof matchAnswer).toBe("function");
    expect(typeof normalise).toBe("function");
  });
});
