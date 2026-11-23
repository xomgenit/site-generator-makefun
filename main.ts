// Driver for site-generator-speed-01-run-20261122: reads every case from
// /input/cases.json, answers each with solve.js run(), writes
// /output/answers.json. V8 flags are tuned before solve.js loads, the way
// the house baseline tunes --no-incremental-marking: --no-opt wins most
// (a single-run batch job pays more CPU for TurboFan compile threads than
// optimized code saves), --single-threaded and --no-lazy cut the remaining
// background-thread CPU. Pure JS, no WASM, no native code.
import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';

setFlagsFromString('--no-incremental-marking --no-opt --single-threaded --no-lazy');

const { run } = await import('./solve.js');
const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(inDir + '/cases.json', 'utf8'));
const answers = [];
for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
const text = JSON.stringify(answers);
writeFileSync(outDir + '/answers.json', text);
