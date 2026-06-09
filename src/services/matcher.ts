/**
 * Pure answer-matching module — no DB, no env.
 *
 * Three primary modes (+ open_ended_with_hints and fallback):
 *   accept           — normalised exact match against accept[]
 *   frame            — glob-prefix match against accept_frames[] (e.g. "my name is *")
 *   open_ended       — any non-empty transcript passes; matched=true if non-empty
 *   open_ended_with_hints — open_ended=true AND accept/frames present; pass on non-empty,
 *                           matched=true only if accept or frames also match (for richer feedback)
 *   fallback         — no accept[], no accept_frames[], not open_ended → content gap; pass on non-empty
 */

export interface Puzzle {
  accept?: string[];
  accept_frames?: string[];
  open_ended?: boolean;
}

export type MatchMode =
  | "accept"
  | "frame"
  | "open_ended"
  | "open_ended_with_hints"
  | "fallback";

export interface MatchResult {
  pass: boolean;
  matched: boolean;
  mode: MatchMode;
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Normalise a transcript or accept string for comparison:
 *   - lowercase
 *   - strip apostrophes, common punctuation, curly quotes
 *   - collapse runs of whitespace to a single space
 *   - trim
 */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:'"'‘’“”…\-–—]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Mode helpers ──────────────────────────────────────────────────────────────

function matchesAccept(transcript: string, accept: string[]): boolean {
  const normT = normalise(transcript);
  return accept.some((a) => normalise(a) === normT);
}

function matchesFrame(transcript: string, frames: string[]): boolean {
  const normT = normalise(transcript);
  return frames.some((frame) => {
    const starIdx = frame.indexOf("*");
    if (starIdx === -1) {
      // No wildcard — treat as exact match
      return normalise(frame) === normT;
    }

    const normPrefix = normalise(frame.slice(0, starIdx));

    if (!normPrefix) {
      // Frame is just "*" — anything non-empty counts
      return normT.length > 0;
    }

    // Transcript must be: "<prefix> <rest>" where rest is at least one token.
    // Use startsWith(prefix + " ") to avoid false-prefixes ("im" matching "image …").
    if (normT === normPrefix) return false; // prefix only, nothing after it

    if (!normT.startsWith(normPrefix + " ")) return false;

    const remainder = normT.slice(normPrefix.length + 1).trim(); // +1 for the space
    return remainder.length > 0;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function matchAnswer(puzzle: Puzzle, transcript: string): MatchResult {
  if (typeof transcript !== "string") {
    throw new TypeError(`matchAnswer: transcript must be a string, got ${typeof transcript}`);
  }

  const isEmpty = !transcript.trim();
  const hasAccept = !!(puzzle.accept?.length);
  const hasFrames = !!(puzzle.accept_frames?.length);
  const isOpenEnded = !!puzzle.open_ended;

  // ── open_ended path ──────────────────────────────────────────────────────────
  if (isOpenEnded) {
    if (isEmpty) {
      const mode: MatchMode = hasAccept || hasFrames ? "open_ended_with_hints" : "open_ended";
      return { pass: false, matched: false, mode };
    }

    const hasHints = hasAccept || hasFrames;
    const mode: MatchMode = hasHints ? "open_ended_with_hints" : "open_ended";

    // For open_ended without hints, any non-empty transcript is "matched"
    if (!hasHints) return { pass: true, matched: true, mode };

    // With hints, matched = true only when accept/frames also fire (richer celebration)
    let matched = hasAccept ? matchesAccept(transcript, puzzle.accept!) : false;
    if (!matched && hasFrames) matched = matchesFrame(transcript, puzzle.accept_frames!);

    return { pass: true, matched, mode };
  }

  // ── non-open-ended paths ─────────────────────────────────────────────────────
  if (isEmpty) {
    const mode: MatchMode = hasFrames ? "frame" : hasAccept ? "accept" : "fallback";
    return { pass: false, matched: false, mode };
  }

  if (hasFrames) {
    const matched = matchesFrame(transcript, puzzle.accept_frames!);
    return { pass: matched, matched, mode: "frame" };
  }

  if (hasAccept) {
    const matched = matchesAccept(transcript, puzzle.accept!);
    return { pass: matched, matched, mode: "accept" };
  }

  // ── fallback: content gap (no matching rules defined) ───────────────────────
  // Pass on any non-empty transcript so the user isn't silently blocked,
  // but flag the mode so content authors can find and fix missing rules.
  return { pass: true, matched: false, mode: "fallback" };
}
