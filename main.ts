// Faster Site Builder: the harness driver. The harness runs `node /bot/main.ts` (node22). It reads every case
// from /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js, and
// writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
// Pre-sized: the harness's whole run is three cases, and growing the array costs a reallocation per case.
const answers: unknown[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) answers[k] = run(cases[k].input);
// The harness mounts /output, but a local run may not have it yet; creating it costs nothing when it exists.
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
