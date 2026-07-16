// Bumps the root package.json's version (major, minor, or patch — patch by
// default), runs sync:chart-version so the Helm chart, values.yaml, and
// web/package.json stay in lockstep, then commits the result. Tagging is
// handled separately by .github/workflows/tag-release.yml.
const bumpType = process.argv[2] ?? "patch";
if (bumpType !== "major" && bumpType !== "minor" && bumpType !== "patch") {
  console.error(
    `Invalid bump type "${bumpType}". Expected "major", "minor", or "patch".`,
  );
  process.exit(1);
}

const packageJsonPath = new URL("../package.json", import.meta.url).pathname;
const packageJsonOriginal = await Bun.file(packageJsonPath).text();
const packageJson = JSON.parse(packageJsonOriginal);

const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!versionMatch) {
  throw new Error(
    `package.json's version "${packageJson.version}" isn't in major.minor.patch form`,
  );
}
const major = Number(versionMatch[1]);
const minor = Number(versionMatch[2]);
const patch = Number(versionMatch[3]);

const nextVersion =
  bumpType === "major"
    ? `${major + 1}.0.0`
    : bumpType === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const packageJsonUpdated = packageJsonOriginal.replace(
  /^(\s*"version":\s*").*(",?)$/m,
  `$1${nextVersion}$2`,
);
await Bun.write(packageJsonPath, packageJsonUpdated);
console.log(`Bumped ${packageJsonPath} from ${packageJson.version} to ${nextVersion}`);

await Bun.$`bun run sync:chart-version`;

const repoRoot = new URL("..", import.meta.url).pathname;
await Bun.$`git add package.json k8s/chat-platform/Chart.yaml k8s/chat-platform/values.yaml web/package.json`.cwd(
  repoRoot,
);
await Bun.$`git commit -m ${`[RELEASE] ${nextVersion}`}`.cwd(repoRoot);
