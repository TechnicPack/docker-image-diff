import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.argv[2];
assert.ok(image, 'Supply the container image to verify');

function docker(args, expectedStatus = 0) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout + (expectedStatus ? result.stderr : '');
}

console.log(docker(['run', '--rm', '--entrypoint', 'sh', image, '-ec',
  'node --version; node -e "if (parseInt(process.versions.node) < 24) process.exit(1)"; docker --version; docker buildx version; test ! -S /var/run/docker.sock',
]));

const failure = docker(['run', '--rm', '--network', 'none', image,
  '--api-url', 'https://git.example.test/api/v4',
  '--project', 'technic/platformapi', '--allowed-registries', 'docker.io',
], 1);
assert.match(failure, /GITLAB_TOKEN/);
console.log(failure.trim());

const repository = 'docker.io/library/node';
const indexDigest = 'sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
const inspect = (...args) => JSON.parse(docker([
  'run', '--rm', '--entrypoint', 'docker', image,
  'buildx', 'imagetools', 'inspect', ...args,
]));
const index = inspect('--raw', `${repository}@${indexDigest}`);
assert.equal(index.schemaVersion, 2);
const descriptor = index.manifests.find(({ platform }) =>
  platform?.os === 'linux' && platform.architecture === 'amd64');
assert.ok(descriptor, 'Index must contain a Linux/amd64 image');
const reference = `${repository}@${descriptor.digest}`;
const manifest = inspect('--raw', reference);
assert.equal(manifest.schemaVersion, 2);
assert.ok(manifest.config.digest);
const config = inspect('--format', '{{json .Image}}', reference);
assert.equal(config.os, 'linux');
assert.equal(config.architecture, 'amd64');
console.log(`Daemonless index, manifest and config inspection passed: ${reference}`);
