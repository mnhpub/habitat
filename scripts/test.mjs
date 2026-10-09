import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const entries = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`);
await mkdir('.test-build', { recursive: true });
await build({
  entryPoints: entries, bundle: true, platform: 'node', format: 'esm', outdir: '.test-build', logLevel: 'warning',
  plugins: [{ name: 'workers-test-runtime', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve('tests/fixtures/workers.ts') }));
  } }],
});
const result = spawnSync(process.execPath, ['--test', ...entries.map(entry => entry.replace('tests/', '.test-build/').replace(/\.ts$/, '.js'))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
