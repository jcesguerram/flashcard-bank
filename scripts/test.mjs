// Runs the unit tests: bundles each tests/*.test.ts with esbuild and runs it with Node.
//   npm test                      → tests/card.test.ts and tests/sync.test.ts
//   npm test -- path/to/note.md   → also checks that every card in that note round-trips unchanged
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const notes = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'flashcard-bank-tests-'));
let status = 0;
for (const name of ['card', 'sync']) {
	const out = join(dir, `${name}.cjs`);
	await esbuild.build({ entryPoints: [`tests/${name}.test.ts`], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning' });
	console.log(`── ${name}.test.ts`);
	const res = spawnSync(process.execPath, [out, ...(name === 'card' ? notes : [])], { stdio: 'inherit' });
	if (res.status !== 0) status = 1;
}
process.exit(status);
