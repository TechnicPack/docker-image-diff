import assert from 'node:assert/strict';
import test from 'node:test';
import { compareImages } from '../src/compare.js';
import { renderReport } from '../src/report.js';

const old = `mariadb:lts@sha256:${'a'.repeat(64)}`;
const next = `mariadb:lts@sha256:${'b'.repeat(64)}`;
const options = { allowedRegistries: ['docker.io'], maxImages: 2 };
const context = { headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40) };
const change = {
  file: 'compose.yml',
  location: 'service:db',
  before: old,
  after: next,
};

test('registry failure cannot be reported as an unchanged or removed platform', async () => {
  const results = await compareImages([change], options, async (reference) => {
    if (reference === next) throw new Error('unavailable');
    return {
      image: reference,
      warnings: [],
      platforms: [{ platform: 'linux/amd64', digest: 'a', version: '1.0' }],
    };
  });
  const report = renderReport(results, context);
  assert.match(
    report,
    /\| linux\/amd64 \| 1\\\.0 \| Not inspected \| Unknown \|/,
  );
  assert.doesNotMatch(report, /\| Removed \|/);
  assert.match(report, /Registry inspection failed/);
});

test('moving tags are never resolved as historical versions and lookup limits stay explicit', async () => {
  const results = await compareImages(
    [
      { ...change, before: 'mariadb:lts' },
      { ...change, location: 'service:second' },
    ],
    { ...options, maxImages: 1 },
    async (reference) => {
      assert.equal(reference, next);
      return {
        image: reference,
        platforms: [{ platform: 'linux/amd64', digest: 'b' }],
        warnings: [],
      };
    },
  );
  assert.equal(results[0].before, undefined);
  assert.match(results[0].warnings.join(), /historical/);
  assert.match(results[1].warnings.join(), /limit reached/);
  assert.equal(results[1].after.platforms[0].digest, 'b');
});

test('report compares platform digests and neutralizes publisher markup and mentions', () => {
  const inspection = {
    image: old,
    warnings: [],
    platforms: [
      {
        platform: 'linux/amd64',
        digest: 'same',
        version: '<script>@everyone|**evil**</script>\n',
      },
    ],
  };
  const report = renderReport(
    [{ change, before: inspection, after: inspection, warnings: [] }],
    context,
  );
  assert.match(report, /\| No \|/);
  assert.doesNotMatch(report, /<script>|@everyone|\|\*\*evil/);
  assert.match(report, /&lt;script&gt;&#64;&#8203;everyone\\\|/);
});

test('missing version labels remain unknown even when an image has a numeric tag', () => {
  const report = renderReport(
    [
      {
        change: { ...change, after: next.replace(':lts', ':12.3.3') },
        before: { platforms: [{ platform: 'linux/amd64', digest: 'a' }] },
        after: { platforms: [{ platform: 'linux/amd64', digest: 'b' }] },
        warnings: [],
      },
    ],
    context,
  );
  assert.match(
    report,
    /\| linux\/amd64 \| Not provided \| Not provided \| Yes \|/,
  );
});
