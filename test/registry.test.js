import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createInspector, parseImage } from '../src/registry.js';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_INDEX =
  'application/vnd.docker.distribution.manifest.list.v2+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const PIN = `sha256:${'a'.repeat(64)}`;
const VERSION = 'org.opencontainers.image.version';
const approved = { allowedRegistries: ['docker.io', 'ghcr.io', 'quay.io'] };

function blob(value) {
  const stdout = JSON.stringify(value);
  return {
    stdout,
    digest: `sha256:${createHash('sha256').update(stdout).digest('hex')}`,
    size: Buffer.byteLength(stdout),
  };
}

function imageConfig(architecture, labels = {}, extra = {}) {
  return {
    os: 'linux',
    architecture,
    config: { Labels: labels },
    rootfs: { type: 'layers', diff_ids: [] },
    ...extra,
  };
}

function fixtureRegistry(repository = 'docker.io/library/example') {
  const raw = new Map();
  const configs = new Map();
  function manifest(value) {
    const stored = blob(value);
    raw.set(stored.digest, stored.stdout);
    return {
      mediaType: value.mediaType,
      digest: stored.digest,
      size: stored.size,
    };
  }
  function image(config, annotations, mediaType = OCI_MANIFEST) {
    const configBlob = blob(config);
    const desc = manifest({
      schemaVersion: 2,
      mediaType,
      config: {
        mediaType:
          mediaType === DOCKER_MANIFEST
            ? 'application/vnd.docker.container.image.v1+json'
            : OCI_CONFIG,
        digest: configBlob.digest,
        size: configBlob.size,
      },
      layers: [],
      ...(annotations ? { annotations } : {}),
    });
    configs.set(desc.digest, configBlob.stdout);
    return desc;
  }
  function index(manifests, annotations, mediaType = OCI_INDEX) {
    return manifest({
      schemaVersion: 2,
      mediaType,
      manifests,
      ...(annotations ? { annotations } : {}),
    });
  }
  const inspect = createInspector({
    execFile: async (program, args, options) => {
      // Reject anything except metadata reads of exact pins in this approved repository.
      assert.equal(program, 'docker');
      assert.equal(options.shell, false);
      assert.deepEqual(args.slice(0, 3), ['buildx', 'imagetools', 'inspect']);
      const config = args[3] === '--format';
      assert.deepEqual(
        args.slice(3, -1),
        config ? ['--format', '{{json .Image}}'] : ['--raw'],
      );
      const reference = args.at(-1);
      assert.ok(reference.startsWith(`${repository}@sha256:`));
      const digest = reference.slice(repository.length + 1);
      const stdout = (config ? configs : raw).get(digest);
      if (stdout === undefined)
        throw new Error('Requested registry content is unavailable.');
      return { stdout };
    },
  });
  return {
    raw,
    configs,
    manifest,
    image,
    index,
    inspect,
    reference: (desc, tag = '') =>
      `${repository}${tag ? `:${tag}` : ''}@${desc.digest}`,
  };
}

test('normalizes Docker Hub aliases and preserves tag and pin without inventing a tag', () => {
  for (const name of [
    'alpine',
    'docker.io/alpine',
    'index.docker.io/alpine',
    'REGISTRY-1.DOCKER.IO/library/alpine',
  ]) {
    assert.equal(
      parseImage(`${name}:3.22@${PIN}`).canonical,
      `docker.io/library/alpine:3.22@${PIN}`,
    );
  }
  assert.equal(
    parseImage('team/app__worker--prod/sub_image:RC_1').canonical,
    'docker.io/team/app__worker--prod/sub_image:RC_1',
  );
  assert.equal(parseImage('alpine').canonical, 'docker.io/library/alpine');
  assert.equal(parseImage('GHCR.IO/technicpack/app').registry, 'ghcr.io');
  assert.equal(
    parseImage('[2001:db8::1]:5000/team/app').registry,
    '[2001:db8::1]:5000',
  );
});

test('rejects hostile references and malformed Docker names instead of interpreting them', () => {
  for (const reference of [
    '--help',
    '../image',
    'docker.io//image',
    'https://ghcr.io/team/image',
    'oci-layout:///tmp/image',
    'image;touch/tmp/file',
    'image$(id)',
    `\${IMAGE}`,
    'user:password@ghcr.io/team/image',
    'docker.io/team/Image',
    'foo%2fbar',
    'image\n--help',
    'image\0',
    ' image',
    'image:',
    'image:@sha256:bad',
    `image@${PIN}@${PIN}`,
    `image@sha256:${'A'.repeat(64)}`,
    'image@sha256:abc',
    'ghcr.io:65536/image',
    'ghcr.io:0/image',
    'ghcr.io./image',
    '[:::]:443/image',
  ]) {
    assert.throws(() => parseImage(reference), Error, reference);
  }
});

test('denies mutable refs, non-SHA256 pins, unapproved hosts, suffixes and implicit ports before lookup', async () => {
  let invoked = false;
  const inspect = createInspector({
    execFile: async () => {
      invoked = true;
      throw new Error('Must not execute.');
    },
  });
  for (const reference of [
    'alpine:latest',
    `alpine@sha512:${'a'.repeat(128)}`,
    `evil.example/app@${PIN}`,
    `ghcr.io.evil.example/app@${PIN}`,
    `ghcr.io:443/app@${PIN}`,
    `localhost:5000/app@${PIN}`,
  ])
    await assert.rejects(inspect(reference, approved));
  await assert.rejects(
    inspect(`alpine@${PIN}`, { allowedRegistries: ['*.docker.io'] }),
  );
  await assert.rejects(inspect(`alpine@${PIN}`, { allowedRegistries: [] }));
  assert.equal(invoked, false);
});

test('permits an explicitly approved host and port without forwarding the mutable tag', async () => {
  const registry = fixtureRegistry('registry.example:5000/team/app');
  const image = registry.image(imageConfig('amd64', { [VERSION]: '1.2.3' }));
  const result = await registry.inspect(registry.reference(image, 'mutable'), {
    allowedRegistries: ['registry.example:5000'],
  });
  assert.equal(result.platforms[0].version, '1.2.3');
  assert.equal(result.platforms[0].digest, image.digest);
});

test('keeps variants and Windows builds distinct while excluding attestations', async () => {
  const registry = fixtureRegistry();
  const arm6 = registry.image(
    imageConfig('arm', { [VERSION]: '2.6' }, { variant: 'v6' }),
  );
  const arm7 = registry.image(
    imageConfig('arm', { [VERSION]: '2.7' }, { variant: 'v7' }),
  );
  const windowsA = registry.image(
    imageConfig(
      'amd64',
      { [VERSION]: '2.win-a' },
      { os: 'windows', 'os.version': '10.0.20348.1000' },
    ),
    undefined,
    DOCKER_MANIFEST,
  );
  const windowsB = registry.image(
    imageConfig(
      'amd64',
      { [VERSION]: '2.win-b' },
      { os: 'windows', 'os.version': '10.0.20348.2000' },
    ),
    undefined,
    DOCKER_MANIFEST,
  );
  const index = registry.index(
    [
      {
        ...arm6,
        platform: { os: 'linux', architecture: 'arm', variant: 'v6' },
      },
      {
        ...arm7,
        platform: { os: 'linux', architecture: 'arm', variant: 'v7' },
      },
      {
        ...windowsA,
        platform: {
          os: 'windows',
          architecture: 'amd64',
          'os.version': '10.0.20348.1000',
        },
      },
      {
        ...windowsB,
        platform: {
          os: 'windows',
          architecture: 'amd64',
          'os.version': '10.0.20348.2000',
        },
      },
      {
        mediaType: OCI_MANIFEST,
        digest: PIN,
        size: 10,
        platform: { os: 'unknown', architecture: 'unknown' },
      },
      {
        mediaType: OCI_MANIFEST,
        digest: PIN,
        size: 10,
        platform: { os: 'linux', architecture: 'amd64' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
      {
        mediaType: OCI_MANIFEST,
        digest: PIN,
        size: 10,
        annotations: { 'com.docker.reference.type': 'attestation-manifest' },
      },
    ],
    undefined,
    DOCKER_INDEX,
  );
  const result = await registry.inspect(registry.reference(index), approved);
  assert.deepEqual(
    result.platforms.map(({ platform, digest, version }) => ({
      platform,
      digest,
      version,
    })),
    [
      { platform: 'linux/arm/v6', digest: arm6.digest, version: '2.6' },
      { platform: 'linux/arm/v7', digest: arm7.digest, version: '2.7' },
      {
        platform: 'windows/amd64 (os.version=10.0.20348.1000)',
        digest: windowsA.digest,
        version: '2.win-a',
      },
      {
        platform: 'windows/amd64 (os.version=10.0.20348.2000)',
        digest: windowsB.digest,
        version: '2.win-b',
      },
    ],
  );
  assert.deepEqual(result.warnings, []);
});

test('fills missing metadata from config labels without overwriting more specific annotations', async () => {
  const registry = fixtureRegistry();
  const image = registry.image(
    imageConfig('amd64', {
      [VERSION]: 'config-version',
      'org.opencontainers.image.base.name': 'alpine:3.22',
      'org.opencontainers.image.base.digest': PIN,
      'org.label-schema.vcs-ref': 'legacy-revision',
      'org.label-schema.vcs-url': 'https://github.com/example/project',
    }),
    {
      [VERSION]: 'manifest-version',
      'org.opencontainers.image.revision': 'manifest-revision',
    },
  );
  const index = registry.index([
    {
      ...image,
      annotations: { [VERSION]: 'descriptor-version' },
      platform: { os: 'linux', architecture: 'amd64' },
    },
  ]);
  const result = await registry.inspect(registry.reference(index), approved);
  assert.deepEqual(result.platforms[0], {
    platform: 'linux/amd64',
    digest: image.digest,
    version: 'descriptor-version',
    baseName: 'alpine:3.22',
    baseDigest: PIN,
    revision: 'manifest-revision',
    source: 'https://github.com/example/project',
  });
});

test('inspects a single-platform manifest and accepts legacy version labels', async () => {
  const registry = fixtureRegistry();
  const image = registry.image(
    imageConfig(
      'arm64',
      { 'org.label-schema.version': '8.1' },
      { variant: 'v8' },
    ),
  );
  const result = await registry.inspect(registry.reference(image), approved);
  assert.deepEqual(result.platforms, [
    { platform: 'linux/arm64/v8', digest: image.digest, version: '8.1' },
  ]);
});

test('does not infer a missing version from tags or environment variables', async () => {
  const registry = fixtureRegistry();
  const image = registry.image(
    imageConfig(
      'amd64',
      {},
      { config: { Env: ['VERSION=9.1', 'APP_VERSION=9.2'] } },
    ),
  );
  const result = await registry.inspect(
    registry.reference(image, '9.3'),
    approved,
  );
  assert.equal(result.platforms[0].version, undefined);
  assert.equal(result.platforms[0].digest, image.digest);
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.includes('version') && warning.includes('linux/amd64'),
    ),
  );
});

test('walks nested indexes at exact pins, using ancestor annotations only as fallback', async () => {
  const registry = fixtureRegistry('ghcr.io/team/app');
  const labeled = registry.image(
    imageConfig('amd64', { [VERSION]: 'specific' }),
  );
  const unlabeled = registry.image(imageConfig('arm64'));
  const nested = registry.index(
    [
      {
        ...labeled,
        urls: ['https://evil.example/manifest'],
        annotations: {
          'org.opencontainers.image.ref.name': 'evil.example/app:latest',
        },
      },
      unlabeled,
    ],
    { [VERSION]: 'nested' },
  );
  const root = registry.index([nested], { [VERSION]: 'root' });
  const result = await registry.inspect(registry.reference(root), approved);
  assert.deepEqual(
    result.platforms.map(({ platform, digest, version }) => ({
      platform,
      digest,
      version,
    })),
    [
      { platform: 'linux/amd64', digest: labeled.digest, version: 'specific' },
      { platform: 'linux/arm64', digest: unlabeled.digest, version: 'nested' },
    ],
  );
});

test('rejects excessive index depth and manifest fanout rather than returning partial results', async () => {
  const registry = fixtureRegistry();
  const image = registry.image(imageConfig('amd64'));
  let deep = image;
  for (let level = 0; level < 5; level++) deep = registry.index([deep]);
  await assert.rejects(
    registry.inspect(registry.reference(deep), approved),
    /depth limit/,
  );
  const wide = registry.index(Array.from({ length: 128 }, () => image));
  await assert.rejects(
    registry.inspect(registry.reference(wide), approved),
    /manifest inspection limit/,
  );
});

test('surfaces failed child or config lookups instead of producing an unchanged platform', async () => {
  const registry = fixtureRegistry();
  const missing = registry.index([
    {
      mediaType: OCI_MANIFEST,
      digest: PIN,
      size: 1,
      platform: { os: 'linux', architecture: 'amd64' },
    },
  ]);
  await assert.rejects(
    registry.inspect(registry.reference(missing), approved),
    /Unable to inspect pinned image manifest/,
  );
  const image = registry.image(imageConfig('amd64'));
  registry.configs.delete(image.digest);
  await assert.rejects(
    registry.inspect(registry.reference(image), approved),
    /Unable to inspect pinned image config/,
  );
});

test('rejects manifest substitution and malformed or unknown structures', async () => {
  const registry = fixtureRegistry();
  const image = registry.image(imageConfig('amd64'));
  registry.raw.set(
    image.digest,
    JSON.stringify({ schemaVersion: 2, manifests: [] }),
  );
  await assert.rejects(
    registry.inspect(registry.reference(image), approved),
    /does not match its pinned digest/,
  );
  for (const value of [
    { schemaVersion: 1, mediaType: OCI_INDEX, manifests: [] },
    { schemaVersion: 2, mediaType: 'application/example', manifests: [] },
    { schemaVersion: 2, mediaType: OCI_INDEX, manifests: {} },
    { schemaVersion: 2, mediaType: OCI_MANIFEST, config: {}, layers: [] },
  ]) {
    const invalid = registry.manifest(value);
    await assert.rejects(
      registry.inspect(registry.reference(invalid), approved),
    );
  }
});

test('does not allow formatted config inspection to follow manifest-supplied foreign URLs', async () => {
  const registry = fixtureRegistry();
  const image = registry.manifest({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    layers: [],
    config: {
      mediaType: OCI_CONFIG,
      digest: PIN,
      size: 100,
      urls: ['https://evil.example/config'],
    },
  });
  await assert.rejects(
    registry.inspect(registry.reference(image), approved),
    /External image config URLs/,
  );
});

test('rejects ambiguous platform digests and descriptor/config platform disagreements', async () => {
  const registry = fixtureRegistry();
  const first = registry.image(imageConfig('amd64', { [VERSION]: '1' }));
  const second = registry.image(imageConfig('amd64', { [VERSION]: '2' }));
  const duplicate = registry.index([first, second]);
  await assert.rejects(
    registry.inspect(registry.reference(duplicate), approved),
    /Conflicting manifests/,
  );
  const mismatched = registry.index([
    { ...first, platform: { os: 'linux', architecture: 'arm64' } },
  ]);
  await assert.rejects(
    registry.inspect(registry.reference(mismatched), approved),
    /config platform differs/,
  );
});

test('attestation-only indexes fail explicitly rather than masquerading as an empty unchanged image', async () => {
  const registry = fixtureRegistry();
  const index = registry.index([
    {
      mediaType: OCI_MANIFEST,
      digest: PIN,
      size: 100,
      platform: { os: 'unknown', architecture: 'unknown' },
    },
  ]);
  await assert.rejects(
    registry.inspect(registry.reference(index), approved),
    /no runnable platform manifests/,
  );
});
