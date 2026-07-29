// Build publishable workspace packages in dependency (topological) order.
//
// Why not `bun --filter '@ait-kit/*' build`? Bun's filter dispatches matching
// packages concurrently (or, with --sequential, in alphabetical order). The
// dependent packages (api-client, api-orpc, api-cloudflare-service) resolve
// @ait-kit/api-core exclusively through packages/api-core/dist/index.d.ts in
// their tsconfig.build.json, while api-core's build starts by deleting that
// directory. A concurrent or alphabetically-ordered start can therefore fail
// with TS2307 because api-core's declarations do not exist yet. This script
// guarantees api-core finishes before any of its dependents begin.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifests = readdirSync(join(rootDir, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .flatMap((dir) => {
    const manifestPath = join(rootDir, "packages", dir, "package.json");
    return existsSync(manifestPath)
      ? [{ dir, manifest: readJsonFile(manifestPath) }]
      : [];
  });

const byDir = new Map(manifests.map(({ dir, manifest }) => [dir, manifest]));
const byName = new Map(
  manifests
    .filter(({ manifest }) => typeof manifest.name === "string")
    .map(({ dir, manifest }) => [manifest.name, dir])
);

const ordered = [];
const visiting = new Set();
function visit(dir) {
  if (ordered.includes(dir)) return;
  if (visiting.has(dir)) {
    throw new Error(`Circular dependency detected involving packages/${dir}`);
  }
  visiting.add(dir);
  const manifest = byDir.get(dir);
  if (manifest) {
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const depDir = byName.get(dep);
      if (depDir) visit(depDir);
    }
  }
  visiting.delete(dir);
  ordered.push(dir);
}
for (const dir of [...byDir.keys()].sort()) visit(dir);

for (const dir of ordered) {
  const manifest = byDir.get(dir);
  const name = manifest.name ?? `packages/${dir}`;
  process.stdout.write(`Building ${name}...\n`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: join(rootDir, "packages", dir),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`packages/${dir} build failed (exit ${result.status})`);
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`);
  }
}
