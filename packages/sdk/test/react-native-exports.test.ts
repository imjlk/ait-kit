import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('require-style resolution with react-native condition reaches every SDK entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'ait-rn-exports-'));
  try {
    const pkg = join(root, 'node_modules/@ait-kit/sdk');
    mkdirSync(pkg, { recursive: true });
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
    for (const [subpath, entry] of Object.entries(manifest.exports) as [string, { import: string }][]) {
      const file = join(pkg, entry.import);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'export {};');
      const name = subpath === '.' ? '@ait-kit/sdk' : `@ait-kit/sdk/${subpath.slice(2)}`;
      const resolved = execFileSync('node', ['--conditions=react-native', '-p', `require.resolve(${JSON.stringify(name)})`], { cwd: root, encoding: 'utf8' }).trim();
      expect(resolved).toBe(realpathSync(file));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
