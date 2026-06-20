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

// Leading ASR filler words — stripped only at the very start of the string.
const FILLER_RE = /^(?:um+|uh+|hmm+|er+)[,\s]+/i;

// Spoken long-form → normalised canonical form (applied after lowercase).
// Lets "I am" and "I’m" map to the same normalised token "im".
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bi am\b/g, "im"],
  [/\byou are\b/g, "youre"],
  [/\bhe is\b/g, "hes"],
  [/\bshe is\b/g, "shes"],
  [/\bit is\b/g, "its"],
  [/\bthey are\b/g, "theyre"],
  [/\bthat is\b/g, "thats"],
];

/**
 * Normalise a transcript or accept string for comparison:
 *   - Unicode NFC (MA-1: Devanagari NFC ≡ NFD after this step)
 *   - lowercase
 *   - strip leading ASR filler ("um,", "uh ")
 *   - expand contractions ("I am" → same token as "I’m")
 *   - strip apostrophes, common punctuation, curly quotes
 *   - collapse runs of whitespace to a single space
 *   - trim
 */
export function normalise(s: string): string {
  let t = s.normalize("NFC").toLowerCase().replace(FILLER_RE, "");
  for (const [pattern, replacement] of CONTRACTIONS) {
    t = t.replace(pattern, replacement);
  }
  return t
    .replace(/['"‘’“”.,!?;:…\-–—]+/g, "")
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
    const normSuffix = normalise(frame.slice(starIdx + 1));

    if (!normPrefix && !normSuffix) {
      // Frame is just "*" — anything non-empty counts
      return normT.length > 0;
    }

    // Determine the slice of normT that the wildcard must cover.
    let start = 0;
    let end = normT.length;

    if (normPrefix) {
      // Prefix must be followed by a space to avoid false-prefix matches ("im" → "image …")
      if (!normT.startsWith(normPrefix + " ")) return false;
      start = normPrefix.length + 1;
    }

    if (normSuffix) {
      // Suffix must be preceded by a space
      if (!normT.endsWith(" " + normSuffix)) return false;
      end = normT.length - normSuffix.length - 1;
    }

    // The wildcard slot must contain at least one non-whitespace character
    return start < end && normT.slice(start, end).trim().length > 0;
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
