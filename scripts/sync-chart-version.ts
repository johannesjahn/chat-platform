// Syncs the chat-platform Helm chart's version fields, and web/package.json's
// version, to the root package.json's version, so neither the image tag a
// fresh `helm install`/`upgrade` pulls (unless overridden with --set) nor the
// frontend's version ever drifts from what's actually published by
// .github/workflows/tag-release.yml.
import packageJson from "../package.json" with { type: "json" };

const version = packageJson.version;

const chartPath = new URL("../k8s/chat-platform/Chart.yaml", import.meta.url)
  .pathname;
const chartOriginal = await Bun.file(chartPath).text();
const chartUpdated = chartOriginal
  .replace(/^version:.*$/m, `version: ${version}`)
  .replace(/^appVersion:.*$/m, `appVersion: "${version}"`);
await Bun.write(chartPath, chartUpdated);
console.log(`Synced ${chartPath} to version ${version}`);

const webPackageJsonPath = new URL("../web/package.json", import.meta.url)
  .pathname;
const webPackageJsonOriginal = await Bun.file(webPackageJsonPath).text();
const webPackageJsonUpdated = webPackageJsonOriginal.replace(
  /^(\s*"version":\s*").*(",?)$/m,
  `$1${version}$2`,
);
await Bun.write(webPackageJsonPath, webPackageJsonUpdated);
console.log(`Synced ${webPackageJsonPath} to version ${version}`);

const valuesPath = new URL("../k8s/chat-platform/values.yaml", import.meta.url)
  .pathname;
const valuesOriginal = await Bun.file(valuesPath).text();
const backendBlock = valuesOriginal.match(/^backend:\n(?:[ \t].*\n?)*/m)?.[0];
if (!backendBlock) {
  throw new Error(
    `Couldn't find a top-level "backend:" block in ${valuesPath}`,
  );
}
const backendBlockUpdated = backendBlock.replace(
  /^(\s*tag:).*$/m,
  `$1 "${version}"`,
);
const valuesUpdated = valuesOriginal.replace(backendBlock, backendBlockUpdated);
await Bun.write(valuesPath, valuesUpdated);
console.log(`Synced ${valuesPath}'s backend.image.tag to ${version}`);
