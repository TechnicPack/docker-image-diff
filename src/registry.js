import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execute = promisify(nodeExecFile);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const CONFIG_TYPES = new Set([
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
]);
const METADATA_KEYS = {
  version: ['org.opencontainers.image.version', 'org.label-schema.version'],
  baseName: ['org.opencontainers.image.base.name'],
  baseDigest: ['org.opencontainers.image.base.digest'],
  revision: ['org.opencontainers.image.revision', 'org.label-schema.vcs-ref'],
  source: ['org.opencontainers.image.source', 'org.label-schema.vcs-url'],
};
const METADATA_ENTRIES = Object.entries(METADATA_KEYS);
const METADATA_FIELDS = Object.keys(METADATA_KEYS);
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_MANIFESTS = 128;
const MAX_DEPTH = 4;

function registryHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new Error('Invalid registry host.');
  }
  const host = value.toLowerCase();
  const match = /^(\[[a-f0-9:]+\]|[^:]+)(?::([0-9]+))?$/.exec(host);
  if (
    !match ||
    !(match[1].startsWith('[')
      ? isIP(match[1].slice(1, -1)) === 6
      : HOST.test(match[1]))
  ) {
    throw new Error('Invalid registry host.');
  }
  if (
    match[2] !== undefined &&
    (Number(match[2]) < 1 || Number(match[2]) > 65535)
  ) {
    throw new Error('Invalid registry port.');
  }
  // A port is an explicit part of the allowlist, even for Docker Hub aliases.
  if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(host))
    return 'docker.io';
  return host;
}

/** Parse Docker references without accepting URLs, shell syntax, or local OCI layouts.
 * @param {string} reference
 * @returns {import('./types.js').Image}
 */
export function parseImage(reference) {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > 512 ||
    /\s/.test(reference)
  ) {
    throw new Error('Invalid image reference.');
  }
  const parts = reference.split('@');
  if (parts.length > 2) throw new Error('Invalid image digest.');
  let name = parts[0];
  const digest = parts[1];
  if (digest !== undefined) {
    const match = /^(sha256|sha384|sha512):([a-f0-9]+)$/.exec(digest);
    if (!match || match[2].length !== Number(match[1].slice(3)) / 4)
      throw new Error('Invalid image digest.');
  }
  let tag;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag))
      throw new Error('Invalid image tag.');
  }
  const slash = name.indexOf('/');
  const first = slash === -1 ? name : name.slice(0, slash);
  const explicitHost =
    slash !== -1 && (/[.:]/.test(first) || first.toLowerCase() === 'localhost');
  const registry = explicitHost ? registryHost(first) : 'docker.io';
  let repository = explicitHost ? name.slice(slash + 1) : name;
  if (!REPOSITORY.test(repository))
    throw new Error('Invalid image repository.');
  if (registry === 'docker.io' && !repository.includes('/'))
    repository = `library/${repository}`;
  const qualified = `${registry}/${repository}`;
  if (qualified.length > 255) throw new Error('Image repository is too long.');
  return {
    registry,
    repository,
    tag,
    digest,
    canonical: `${qualified}${tag ? `:${tag}` : ''}${digest ? `@${digest}` : ''}`,
  };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringMap(value, description) {
  if (value === undefined || value === null) return {};
  if (
    !record(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`Invalid ${description}.`);
  }
  return value;
}

function metadata(...sources) {
  const result = {};
  for (const [field, keys] of METADATA_ENTRIES) {
    for (const source of sources) {
      for (const key of keys) {
        const value = source[key]?.trim();
        if (value) {
          result[field] = value;
          break;
        }
      }
      if (result[field] !== undefined) break;
    }
  }
  return result;
}

function completeMetadata(value) {
  return METADATA_FIELDS.every((key) => value[key] !== undefined);
}

function platform(value) {
  if (!record(value)) throw new Error('Image platform is missing.');
  const result = {};
  for (const key of ['os', 'architecture', 'variant', 'os.version']) {
    const entry = value[key];
    if (entry === undefined || entry === '') {
      if (key === 'os' || key === 'architecture')
        throw new Error('Image platform is incomplete.');
      continue;
    }
    if (
      typeof entry !== 'string' ||
      entry.length > 128 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(entry) ||
      entry === 'unknown'
    ) {
      throw new Error('Invalid image platform.');
    }
    result[key] = entry;
  }
  return result;
}

function platformName(value) {
  return `${value.os}/${value.architecture}${value.variant ? `/${value.variant}` : ''}${value['os.version'] ? ` (os.version=${value['os.version']})` : ''}`;
}

function descriptor(value) {
  if (
    !record(value) ||
    typeof value.mediaType !== 'string' ||
    !SHA256.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw new Error('Invalid or non-SHA256 image descriptor.');
  }
}

function manifestKind(value, expectedType) {
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    value.artifactType !== undefined
  ) {
    throw new Error('Unsupported image manifest structure.');
  }
  let type = value.mediaType ?? expectedType;
  if (
    value.mediaType !== undefined &&
    expectedType !== undefined &&
    value.mediaType !== expectedType
  ) {
    throw new Error('Manifest media type differs from its descriptor.');
  }
  // OCI permits an omitted mediaType, but still requires an unambiguous v2 structure.
  if (type === undefined) {
    if (
      Array.isArray(value.manifests) &&
      value.config === undefined &&
      value.layers === undefined
    )
      type = 'application/vnd.oci.image.index.v1+json';
    else if (
      record(value.config) &&
      Array.isArray(value.layers) &&
      value.manifests === undefined
    )
      type = 'application/vnd.oci.image.manifest.v1+json';
  }
  if (
    INDEX_TYPES.has(type) &&
    Array.isArray(value.manifests) &&
    value.config === undefined &&
    value.layers === undefined
  )
    return 'index';
  if (
    MANIFEST_TYPES.has(type) &&
    record(value.config) &&
    Array.isArray(value.layers) &&
    value.manifests === undefined
  ) {
    descriptor(value.config);
    if (!CONFIG_TYPES.has(value.config.mediaType))
      throw new Error('Unsupported image config media type.');
    // buildx fetches config descriptors internally. Do not let a manifest supply an alternate host.
    if (
      value.config.urls !== undefined &&
      (!Array.isArray(value.config.urls) || value.config.urls.length !== 0)
    ) {
      throw new Error('External image config URLs are not permitted.');
    }
    for (const layer of value.layers) descriptor(layer);
    return 'manifest';
  }
  throw new Error('Unsupported image manifest structure or media type.');
}

/**
 * Create an inspector with an optional promise-based execFile-compatible executor.
 * The executor returns { stdout: string }; production always uses node:child_process.execFile.
 * Each inspection has a total time budget, 2 MiB output per command, at most 128
 * manifest descriptors, and at most four nested index edges.
 * @param {{execFile?: typeof execute}} [options]
 */
export function createInspector({ execFile = execute } = {}) {
  /** @param {string} reference
   * @param {{allowedRegistries: string[], timeoutMs?: number}} options
   * @returns {Promise<import('./types.js').Inspection>}
   */
  return async function inspect(
    reference,
    { allowedRegistries, timeoutMs = 30_000 } = {},
  ) {
    const image = parseImage(reference);
    if (!SHA256.test(image.digest))
      throw new Error('Inspection requires a SHA256-pinned image.');
    if (
      !Array.isArray(allowedRegistries) ||
      !allowedRegistries.map(registryHost).includes(image.registry)
    ) {
      throw new Error('Image registry is not approved.');
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw new Error('Invalid inspection timeout (1–120000 ms required).');
    const deadline = Date.now() + timeoutMs;
    const repository = `${image.registry}/${image.repository}`;
    const manifests = new Map();
    const configs = new Map();
    const found = new Map();
    const warnings = [];
    let manifestCount = 0;

    async function command(digest, config) {
      if (!SHA256.test(digest))
        throw new Error('Inspection requires a SHA256-pinned image.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Image inspection timed out.');
      const args = [
        'buildx',
        'imagetools',
        'inspect',
        ...(config ? ['--format', '{{json .Image}}'] : ['--raw']),
        `${repository}@${digest}`,
      ];
      let stdout;
      try {
        ({ stdout } = await execFile('docker', args, {
          encoding: 'utf8',
          timeout: remaining,
          maxBuffer: MAX_OUTPUT,
          killSignal: 'SIGKILL',
          windowsHide: true,
          shell: false,
        }));
      } catch (cause) {
        throw new Error(
          config
            ? 'Unable to inspect pinned image config.'
            : 'Unable to inspect pinned image manifest.',
          { cause },
        );
      }
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT)
        throw new Error('Invalid or oversized image inspection output.');
      if (
        !config &&
        `sha256:${createHash('sha256').update(stdout).digest('hex')}` !== digest
      ) {
        throw new Error(
          'Image manifest content does not match its pinned digest.',
        );
      }
      try {
        return JSON.parse(stdout);
      } catch (cause) {
        throw new Error('Invalid image inspection JSON.', { cause });
      }
    }

    function load(digest, config = false) {
      const cache = config ? configs : manifests;
      if (!cache.has(digest)) cache.set(digest, command(digest, config));
      return cache.get(digest);
    }

    function add(digest, target, details) {
      const name = platformName(target);
      const previous = found.get(name);
      if (previous) {
        if (
          previous.digest !== digest ||
          METADATA_FIELDS.some((key) => previous[key] !== details[key])
        ) {
          throw new Error(`Conflicting manifests for platform ${name}.`);
        }
        return;
      }
      found.set(name, { platform: name, digest, ...details });
      if (!details.version)
        warnings.push(`No version annotation or label was found for ${name}.`);
    }

    async function visit(digest, depth, desc, inherited = []) {
      if (++manifestCount > MAX_MANIFESTS)
        throw new Error('Image exceeds the manifest inspection limit.');
      if (depth > MAX_DEPTH)
        throw new Error('Image exceeds the nested index depth limit.');
      const annotations = stringMap(
        desc?.annotations,
        'manifest descriptor annotations',
      );
      if (
        desc &&
        ((desc.platform?.os === 'unknown' &&
          desc.platform?.architecture === 'unknown') ||
          ['vnd.docker.reference.type', 'com.docker.reference.type'].some(
            (key) =>
              ['attestation', 'attestation-manifest'].includes(
                annotations[key],
              ),
          ))
      )
        return;
      if (
        desc &&
        !INDEX_TYPES.has(desc.mediaType) &&
        !MANIFEST_TYPES.has(desc.mediaType)
      )
        throw new Error('Unsupported manifest descriptor media type.');
      let target =
        desc?.platform === undefined ? undefined : platform(desc.platform);
      const descriptorMetadata = metadata(annotations);
      if (
        desc &&
        MANIFEST_TYPES.has(desc.mediaType) &&
        target &&
        completeMetadata(descriptorMetadata)
      ) {
        add(digest, target, descriptorMetadata);
        return;
      }
      const raw = await load(digest);
      const kind = manifestKind(raw, desc?.mediaType);
      const ownAnnotations = stringMap(raw.annotations, 'image annotations');
      if (kind === 'index') {
        if (raw.manifests.length === 0)
          throw new Error('Image index contains no manifests.');
        if (manifestCount + raw.manifests.length > MAX_MANIFESTS)
          throw new Error('Image exceeds the manifest inspection limit.');
        const fallback = [annotations, ownAnnotations, ...inherited];
        for (const child of raw.manifests) {
          descriptor(child);
          // Ignore descriptor URLs and tags: every traversal stays in the approved repository.
          await visit(child.digest, depth + 1, child, fallback);
        }
        return;
      }
      let labels = {};
      if (!target || !completeMetadata(metadata(annotations, ownAnnotations))) {
        const config = await load(digest, true);
        if (!record(config)) throw new Error('Invalid image config.');
        const configPlatform = platform(config);
        if (target) {
          for (const key of ['os', 'architecture', 'variant', 'os.version']) {
            if (
              target[key] !== undefined &&
              configPlatform[key] !== undefined &&
              target[key] !== configPlatform[key]
            ) {
              throw new Error(
                'Image config platform differs from its descriptor.',
              );
            }
          }
        }
        target = { ...configPlatform, ...target };
        if (config.config !== undefined && !record(config.config))
          throw new Error('Invalid image config settings.');
        labels = stringMap(config.config?.Labels, 'image labels');
      }
      add(
        digest,
        target,
        metadata(annotations, ownAnnotations, labels, ...inherited),
      );
    }

    await visit(image.digest, 0);
    if (found.size === 0)
      throw new Error('Image contains no runnable platform manifests.');
    return {
      image: image.canonical,
      platforms: [...found.values()].sort((a, b) =>
        a.platform.localeCompare(b.platform),
      ),
      warnings,
    };
  };
}

export const inspectImage = createInspector();
