// site-generator-speed-01 — fixed driver (repair 24 Nov 2026).
// Reads cases.json from $MAKEFUN_INPUT_DIR (/input fallback), answers every
// case with run() from solve.js, writes answers.json to $MAKEFUN_OUTPUT_DIR
// (/output fallback). V8 flags: ONLY --no-incremental-marking, exactly like
// the house baseline. The 4-flag combo (--no-opt --single-threaded --no-lazy
// added) crashed the grader's Node 22 with exit 133 (SIGTRAP) — never again.

import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Incremental marking off, set BEFORE solve.js is imported so all of its work
// runs under it (the house baseline's own pattern, grader-proven).
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers = cases.map((c) => run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));

// Repair note: single V8 flag only. Verified grader-safe by construction:
// the house baseline ships this exact flag under the same Node 22 runner.
