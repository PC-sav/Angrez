import argparse, json, os, sys

STAGE_FILES = [
    "content/stage-1-hello-english.json",
    "content/stage-2-everyday-talk.json",
]
OUT_BASE = "assets"
EN_LANG, EN_VOICE = "en-IN", "en-IN-Neural2-A"
HI_LANG, HI_VOICE = "hi-IN", "hi-IN-Neural2-A"
SPEAKING_RATE = 0.95


def text_for(d, key, path):
    if key == "prompt_audio":
        return d.get("prompt_en")
    if key == "ai_line_audio":
        return d.get("ai_line_en")
    if key == "audio":
        if path.startswith("audio/hi/"):
            return d.get("prompt_l1") or d.get("l1") or d.get("text_l1")
        return d.get("en") or d.get("prompt_en") or d.get("target") or d.get("ai_line_en")
    return None


def build_manifest(stage_files):
    manifest, conflicts, missing = {}, [], []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and "audio" in k.lower() and v.endswith(".mp3"):
                    lang = "hi" if v.startswith("audio/hi/") else "en"
                    t = text_for(o, k, v)
                    if not t:
                        missing.append((v, k))
                    elif v in manifest and manifest[v]["text"] != t:
                        conflicts.append((v, manifest[v]["text"], t))
                    else:
                        manifest.setdefault(v, {"path": v, "lang": lang, "text": t})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    for f in stage_files:
        if not os.path.exists(f):
            sys.exit("ERROR: content file not found: " + f)
        with open(f, encoding="utf-8") as fh:
            walk(json.load(fh))

    return sorted(manifest.values(), key=lambda x: (x["lang"], x["path"])), conflicts, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files, conflicts, missing = build_manifest(STAGE_FILES)
    total = sum(len(x["text"]) for x in files)
    en = [x for x in files if x["lang"] == "en"]
    hi = [x for x in files if x["lang"] == "hi"]
    print("Manifest: %d files (%d en + %d hi) %d chars" % (len(files), len(en), len(hi), total))
    for p, a, b in conflicts:
        print("  conflict:", p, repr(a), "vs", repr(b))
    for p, k in missing:
        print("  MISSING TEXT:", p, k)

    with open("tts_manifest_s1_s2.json", "w", encoding="utf-8") as fh:
        json.dump({"count": len(files), "files": files}, fh, ensure_ascii=False, indent=2)

    if args.dry_run:
        for x in files:
            print(" ", x["path"], " <= ", repr(x["text"]))
        print("dry-run: nothing synthesized.")
        return

    from google.cloud import texttospeech
    client = texttospeech.TextToSpeechClient()

    def synth(text, lang, voice, out_path):
        resp = client.synthesize_speech(
            input=texttospeech.SynthesisInput(text=text),
            voice=texttospeech.VoiceSelectionParams(language_code=lang, name=voice),
            audio_config=texttospeech.AudioConfig(
                audio_encoding=texttospeech.AudioEncoding.MP3,
                speaking_rate=SPEAKING_RATE,
            ),
        )
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(resp.audio_content)

    made, skipped = 0, 0
    for i, x in enumerate(files, 1):
        out_path = os.path.join(OUT_BASE, x["path"])
        if os.path.exists(out_path) and not args.force:
            skipped += 1
            continue
        lang, voice = (EN_LANG, EN_VOICE) if x["lang"] == "en" else (HI_LANG, HI_VOICE)
        synth(x["text"], lang, voice, out_path)
        made += 1
        print("  [%d/%d] %s" % (i, len(files), x["path"]))

    print("Done. Generated %d, skipped %d." % (made, skipped))


if __name__ == "__main__":
    main()