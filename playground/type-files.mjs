import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
export function captureTypeFiles() {
  const files = {}, hashes = {}, packages = {};
  const add = (name, path) => {
    const text = readFileSync(path, 'utf8'); files[name] = text;
    hashes[name] = createHash('sha256').update(text).digest('hex');
  };
  for (const name of ['@denaudio/den', '@unworklet/core', 'typescript']) {
    const directory = realpathSync(join(root, 'node_modules', name));
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    packages[name] = { version: pkg.version, exports: pkg.exports };
    add(`/project/node_modules/${name}/package.json`, join(directory, 'package.json'));
    const folder = name === 'typescript' ? 'lib' : 'dist';
    const walk = (relative) => {
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.d\.(?:ts|mts|cts)$/.test(child)) add(`/project/node_modules/${name}/${child}`, join(directory, child));
      }
    };
    walk(folder);
  }
  return { files, hashes, packages };
}
