/**
 * scripts/seed-content.ts
 *
 * Reads every JSON file from content/, validates it, and UPSERTs into
 * content_packs keyed on (stage, version, language).
 * Idempotent: running twice updates existing rows, never duplicates.
 *
 * Usage:
 *   npm run seed:content
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import pool from "../src/lib/db";

const CONTENT_DIR = path.resolve(__dirname, "../content");

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubStage {
  id: string;
  title_en?: string;
  practice?: unknown[];
  mastery_check?: unknown[];
}

interface Pack {
  stage: number;
  version: number;
  language: string;
  name_en?: string;
  name_l1?: string;
  sub_stages: SubStage[];
  [key: string]: unknown;
}

interface ContentFile {
  pack: Pack;
  _meta?: unknown;
  [key: string]: unknown;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(pack: unknown, filename: string): asserts pack is Pack {
  if (!pack || typeof pack !== "object") {
    throw new Error(`${filename}: "pack" must be an object`);
  }
  const p = pack as Record<string, unknown>;
  if (typeof p.stage !== "number" || !Number.isInteger(p.stage)) {
    throw new Error(`${filename}: pack.stage must be an integer, got ${JSON.stringify(p.stage)}`);
  }
  if (typeof p.version !== "number" || !Number.isInteger(p.version)) {
    throw new Error(`${filename}: pack.version must be an integer, got ${JSON.stringify(p.version)}`);
  }
  if (p.language !== "hi") {
    throw new Error(`${filename}: pack.language must be 'hi', got ${JSON.stringify(p.language)}`);
  }
  if (!Array.isArray(p.sub_stages) || p.sub_stages.length === 0) {
    throw new Error(`${filename}: pack.sub_stages must be a non-empty array`);
  }
}

// ── Seeder ────────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`No JSON files found in ${CONTENT_DIR}`);
    process.exit(1);
  }

  console.log(`Seeding ${files.length} content pack(s) from ${CONTENT_DIR}\n`);

  let inserted = 0;
  let updated = 0;

  for (const file of files) {
    const filepath = path.join(CONTENT_DIR, file);

    let parsed: ContentFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filepath, "utf8")) as ContentFile;
    } catch (e) {
      console.error(`  ERROR  ${file}: JSON parse failed — ${(e as Error).message}`);
      process.exit(1);
    }

    if (!parsed.pack) {
      console.error(`  ERROR  ${file}: missing top-level "pack" key`);
      process.exit(1);
    }

    try {
      validate(parsed.pack, file);
    } catch (e) {
      console.error(`  ERROR  ${(e as Error).message}`);
      process.exit(1);
    }

    const pack = parsed.pack;

    // Pre-flight: was this row already present?
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM content_packs WHERE stage=$1 AND version=$2 AND language=$3",
      [pack.stage, pack.version, pack.language],
    );
    const isUpdate = existing.rows.length > 0;

    await pool.query(
      `INSERT INTO content_packs (stage, version, language, json, published_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (stage, version, language)
       DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
      [pack.stage, pack.version, pack.language, JSON.stringify(pack)],
    );

    const action = isUpdate ? "updated" : "inserted";
    const subCount = pack.sub_stages.length;
    const subIds = pack.sub_stages.map((s) => s.id).join(", ");
    console.log(
      `  ${action.padEnd(8)} Stage ${pack.stage} v${pack.version} (${pack.language})` +
      ` — "${pack.name_en}" — ${subCount} sub-stages [${subIds}]`,
    );
    isUpdate ? updated++ : inserted++;
  }

  console.log(`\nDone. ${inserted} inserted, ${updated} updated.`);
}

seed()
  .catch((e: Error) => {
    console.error("Seed error:", e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
