import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const checkOnly = process.argv.includes("--check");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function workspacePatterns(manifest) {
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;

  if (!Array.isArray(workspaces) || workspaces.some((value) => typeof value !== "string")) {
    throw new Error("package.json must define workspaces as an array of path patterns.");
  }

  return workspaces;
}

async function findManifestPaths(rootManifest) {
  const manifestPaths = new Set(["package.json"]);

  for (const pattern of workspacePatterns(rootManifest)) {
    const directChildren = /^([^*?[\]{}]+)\/\*$/.exec(pattern);

    if (!directChildren) {
      if (/[*?[\]{}]/.test(pattern)) {
        throw new Error(`Unsupported workspace pattern: ${pattern}`);
      }

      manifestPaths.add(path.join(pattern, "package.json"));
      continue;
    }

    const parent = directChildren[1];
    const entries = await readdir(path.join(root, parent), { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        manifestPaths.add(path.join(parent, entry.name, "package.json"));
      }
    }
  }

  return [...manifestPaths].sort();
}

async function readManifest(manifestPath) {
  try {
    const contents = await readFile(path.join(root, manifestPath), "utf8");
    return JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${manifestPath}: ${message}`, { cause: error });
  }
}

function syncVersionSpec(currentSpec, version) {
  if (["workspace:*", "workspace:^", "workspace:~"].includes(currentSpec)) {
    return currentSpec;
  }

  const match = /^(workspace:)?([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
    currentSpec,
  );

  if (!match) {
    return currentSpec;
  }

  return `${match[1] ?? ""}${match[2]}${version}`;
}

const rootManifest = await readManifest("package.json");
const manifestPaths = await findManifestPaths(rootManifest);
const manifests = new Map([["package.json", rootManifest]]);

for (const manifestPath of manifestPaths) {
  if (manifestPath !== "package.json") {
    manifests.set(manifestPath, await readManifest(manifestPath));
  }
}

const internalVersions = new Map();

for (const [manifestPath, manifest] of manifests) {
  // Private workspaces consume released packages but are not release version sources.
  if (
    manifestPath !== "package.json" &&
    manifest.private !== true &&
    typeof manifest.name === "string" &&
    typeof manifest.version === "string"
  ) {
    internalVersions.set(manifest.name, manifest.version);
  }
}

const changes = [];
const changedManifests = new Set();

for (const [manifestPath, manifest] of manifests) {
  for (const field of dependencyFields) {
    const dependencies = manifest[field];

    if (!dependencies) {
      continue;
    }

    for (const [name, currentSpec] of Object.entries(dependencies)) {
      const version = internalVersions.get(name);

      if (!version || typeof currentSpec !== "string") {
        continue;
      }

      const nextSpec = syncVersionSpec(currentSpec, version);

      if (nextSpec === currentSpec) {
        continue;
      }

      changes.push({ field, from: currentSpec, manifestPath, name, to: nextSpec });
      dependencies[name] = nextSpec;
      changedManifests.add(manifestPath);
    }
  }
}

if (changes.length === 0) {
  console.log("Internal dependency versions are synchronized.");
  process.exit(0);
}

for (const change of changes) {
  console.error(
    `${change.manifestPath}: ${change.field}.${change.name} ${change.from} -> ${change.to}`,
  );
}

if (checkOnly) {
  console.error("Internal dependency versions are out of sync.");
  process.exit(1);
}

for (const manifestPath of changedManifests) {
  const manifest = manifests.get(manifestPath);
  await writeFile(
    path.join(root, manifestPath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

console.log(`Updated ${changedManifests.size} workspace manifest(s).`);
