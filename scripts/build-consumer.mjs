import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const run = (args, cwd) => execFileSync('npm', ['--cache', join(tmpdir(), 'den-npm-cache'), ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

// The deployment and entry test use the same isolated, packed-package consumer.
export function buildConsumer({ stageSite = true } = {}) {
  const consumer = mkdtempSync(join(tmpdir(), 'den-consumer-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], root));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  // Only the local candidate changes; registry dependencies stay locked.
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  run(['ci', '--include=dev', '--ignore-scripts'], consumer);
  run(['run', 'check'], consumer);
  run(['run', 'build'], consumer);
  const output = stageSite ? join(root, 'site-dist') : join(consumer, 'dist');
  if (stageSite) {
    rmSync(output, { recursive: true, force: true });
    cpSync(join(consumer, 'dist'), output, { recursive: true });
  }
  return { consumer, pack, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output } = buildConsumer();
    console.log(`Built packed den consumer: ${output}`);
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
