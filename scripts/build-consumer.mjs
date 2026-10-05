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
export function buildConsumer({ stageSite = true, fixture = 'tests/consumer' } = {}) {
  const consumer = mkdtempSync(join(tmpdir(), 'den-consumer-'));
  cpSync(join(root, fixture), consumer, { recursive: true });
  const [pack] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], root));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  // Public build identity only; never expose the environment wholesale. Vercel
  // can omit .git, so use its documented commit SHA if no repository is present.
  let sourceCommit = null, sourceDirty = null, sourceIdentity = 'unavailable';
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    if (resolve(top) === root) {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
      sourceDirty = execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim() !== '';
      sourceIdentity = 'git';
    }
  } catch {}
  const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!sourceCommit && typeof vercelCommit === 'string' && /^[0-9a-f]{40}$/i.test(vercelCommit)) {
    sourceCommit = vercelCommit.toLowerCase(); sourceIdentity = 'vercel';
  }
  writeFileSync(join(consumer, 'candidate-provenance.json'), JSON.stringify({
    status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED',
    sourceCommit, sourceDirty, sourceIdentity, packageIntegrity: pack.integrity,
  }, null, 2) + '\n');
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
