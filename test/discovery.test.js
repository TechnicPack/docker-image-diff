import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverImages, isSupportedFile } from '../src/discovery.js';

const compose = (content) =>
  discoverImages('deploy/compose.production.yaml', content);
const dockerfile = (content) =>
  discoverImages('images/Dockerfile.production', content);

test('recognizes supported definition names in nested directories', () => {
  for (const path of [
    'compose.yaml',
    'nested/compose.yml',
    'a/b/compose.production.yaml',
    'a/docker-compose.yml',
    'a/docker-compose.override.yaml',
    'docker-compose-test.yml',
    'Dockerfile',
    'images/Dockerfile.production',
    'images/build.Dockerfile',
  ]) {
    assert.equal(isSupportedFile(path), true, path);
  }
  for (const path of [
    'values.yaml',
    'compose.json',
    'Dockerfile.txt.old/file',
    'Dockerfiles',
    'compose.yaml.bak',
  ]) {
    assert.equal(isSupportedFile(path), false, path);
  }
});

test('Compose merges inherit images and explicit service images override them', () => {
  const result = compose(`
x-defaults: &defaults
  image: alpine:3.21
x-secondary: &secondary
  image: busybox:1.37
services:
  inherited:
    <<: *defaults
  overridden:
    <<: *defaults
    image: node:24
  sequence:
    <<: [*defaults, *secondary]
  build-only:
    build: .
`);
  assert.deepEqual(result.references, [
    { key: 'service:inherited', image: 'alpine:3.21' },
    { key: 'service:overridden', image: 'node:24' },
    { key: 'service:sequence', image: 'alpine:3.21' },
  ]);
  assert.deepEqual(result.warnings, []);
});

test('Compose alias expansion is bounded even in non-image configuration', () => {
  const result = compose(`
x-small: &small [a, b, c, d, e, f, g, h, i, j]
x-large: &large [*small, *small, *small, *small, *small, *small, *small, *small, *small, *small]
x-huge: &huge [*large, *large, *large, *large, *large, *large, *large, *large, *large, *large]
services:
  app:
    image: alpine:3.21
    environment: *huge
`);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.references, []);
  assert.match(result.warnings.join('\n'), /alias|resource|excessive/i);
});

test('Compose interpolation excludes only its service and never evaluates defaults', () => {
  const result = compose(`
services:
  dynamic:
    image: \${IMAGE:-alpine:3.21}
  escaped:
    image: $$IMAGE
  literal:
    image: busybox:1.37
`);
  assert.deepEqual(result.references, [
    { key: 'service:literal', image: 'busybox:1.37' },
  ]);
  assert.deepEqual(result.skippedKeys, ['service:dynamic', 'service:escaped']);
  assert.notEqual(result.incomplete, true);
  assert.match(result.warnings.join('\n'), /unresolved variables/i);
});

test('Compose malformed YAML, duplicate keys, custom tags, and aliases cannot masquerade as removed images', () => {
  for (const content of [
    'services: [',
    'services:\n  app: {image: alpine}\n  app: {image: busybox}\n',
    'services:\n  app:\n    image: !!js/function function() { throw 1; }\n',
    'services:\n  app: *missing\n',
  ]) {
    const result = compose(content);
    assert.equal(result.incomplete, true, content);
    assert.deepEqual(result.references, [], content);
    assert.match(result.warnings.join('\n'), /YAML/i, content);
  }
});

test('Compose service structure failures preserve usable siblings but exclude ambiguous keys', () => {
  const result = compose(`
services:
  invalid: false
  non-string: {image: 123}
  usable: {image: alpine}
`);
  assert.deepEqual(result.references, [
    { key: 'service:usable', image: 'alpine' },
  ]);
  assert.deepEqual(result.skippedKeys, [
    'service:invalid',
    'service:non-string',
  ]);
  assert.notEqual(result.incomplete, true);
});

test('image definition size bound measures bytes rather than characters', () => {
  const result = compose(`#${'é'.repeat(512 * 1024)}`);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.references, []);
  assert.match(result.warnings.join('\n'), /limit/i);
});

test('Dockerfile continuations, flags, keyword case, and multistage references retain stable identities', () => {
  const result = dockerfile(
    [
      'fRoM --platform=$BUILDPLATFORM \\',
      '  node:24 \\',
      '  # a comment does not end a continued instruction',
      '  aS Build',
      'FROM bUiLd AS test',
      'FROM scratch AS empty',
      'FROM \\',
      '  alpine:3.21 \\',
      '  AS runtime',
      'FROM busybox:1.37',
    ].join('\r\n'),
  );
  assert.deepEqual(result.references, [
    { key: 'stage:build', image: 'node:24' },
    { key: 'stage:runtime', image: 'alpine:3.21' },
    { key: 'stage:4', image: 'busybox:1.37' },
  ]);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.skippedKeys, []);
  assert.match(result.warnings.join('\n'), /platform.*unresolved/i);
});

test('Dockerfile ARG references remain unresolved and still define a stage alias', () => {
  const result = dockerfile(
    `ARG BASE=alpine\nFROM \${BASE} AS base\nFROM base AS derived\nFROM busybox\n`,
  );
  assert.deepEqual(result.references, [{ key: 'stage:2', image: 'busybox' }]);
  assert.deepEqual(result.skippedKeys, ['stage:base']);
  assert.equal(result.incomplete, false);
  assert.match(result.warnings.join('\n'), /unresolved variables/i);
});

test('malformed FROM instructions are never guessed as image removals', () => {
  for (const instruction of [
    'FROM',
    'FROM alpine AS',
    'FROM alpine invalid',
    'FROM alpine AS 123',
    'FROM --platform= alpine',
    'FROM --platform=linux/amd64',
    'FROM --platform linux/amd64 alpine',
    'FROM --unknown=flag alpine',
    'FROM alpine AS final extra',
    'FROM alpine # not an inline comment',
  ]) {
    const result = dockerfile(instruction);
    assert.deepEqual(result.references, [], instruction);
    assert.equal(result.incomplete, true, instruction);
    assert.match(result.warnings.join('\n'), /FROM/i, instruction);
  }
});

test('duplicate stage aliases exclude both ambiguous references, not unrelated stages', () => {
  const result = dockerfile(
    'FROM alpine AS build\nFROM busybox AS BUILD\nFROM node AS runtime\n',
  );
  assert.deepEqual(result.references, [
    { key: 'stage:runtime', image: 'node' },
  ]);
  assert.deepEqual(result.skippedKeys, ['stage:build']);
  assert.match(result.warnings.join('\n'), /duplicate stage alias/i);
});

test('heredoc payload cannot inject a fake FROM instruction', () => {
  const result = dockerfile(
    'FROM alpine\nRUN cat <<EOF\nFROM malicious.example/fake\nEOF\nFROM busybox\n',
  );
  assert.deepEqual(result.references, [{ key: 'stage:0', image: 'alpine' }]);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings.join('\n'), /heredoc/i);
});

test('unsupported escape directives and unterminated continuations mark incomplete discovery', () => {
  const escaped = dockerfile('# escape=`\nFROM `\nalpine\n');
  assert.deepEqual(escaped.references, []);
  assert.equal(escaped.incomplete, true);
  const continued = dockerfile('FROM alpine \\\n# comment\n');
  assert.deepEqual(continued.references, []);
  assert.equal(continued.incomplete, true);
  assert.match(continued.warnings.join('\n'), /continuation/i);
});

test('pairing keys follow service and stage identities rather than order or image', () => {
  const beforeCompose = compose(
    'services:\n  api: {image: alpine}\n  worker: {image: busybox}\n',
  );
  const afterCompose = compose(
    'services:\n  worker: {image: busybox:1.37}\n  api: {image: alpine:3.21}\n',
  );
  const imagesByKey = (result) =>
    Object.fromEntries(result.references.map(({ key, image }) => [key, image]));
  assert.deepEqual(imagesByKey(beforeCompose), {
    'service:api': 'alpine',
    'service:worker': 'busybox',
  });
  assert.deepEqual(imagesByKey(afterCompose), {
    'service:api': 'alpine:3.21',
    'service:worker': 'busybox:1.37',
  });
  const beforeDocker = dockerfile(
    'FROM alpine AS base\nFROM busybox AS tools\n',
  );
  const afterDocker = dockerfile(
    'FROM busybox:1.37 AS tools\nFROM alpine:3.21 AS BASE\n',
  );
  assert.deepEqual(imagesByKey(beforeDocker), {
    'stage:base': 'alpine',
    'stage:tools': 'busybox',
  });
  assert.deepEqual(imagesByKey(afterDocker), {
    'stage:base': 'alpine:3.21',
    'stage:tools': 'busybox:1.37',
  });
});
