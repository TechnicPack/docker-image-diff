import { COMMENT_MARKER } from './github.js';

const MAX_REPORT_LENGTH = 60000;

/** Escape all external strings: image metadata and PR content are untrusted. */
export function escapeMarkdown(value, limit = 240) {
  return (
    String(value)
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .slice(0, limit)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_{}[\]()#+.!|~])/g, '\\$1')
      // Entity encoding alone still creates GitHub mentions after GFM parsing.
      .replace(/@/g, '&#64;&#8203;')
  );
}

function metadata(value) {
  return value ? escapeMarkdown(value, 160) : 'Not provided';
}

function imageCode(reference) {
  const text = String(reference)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .slice(0, 512)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Code spans suppress mentions without inserting invisible characters into copyable references.
  return `<code>${text}</code>`;
}

function renderComparison({ change, before, after, warnings }) {
  const lines = [
    `### ${escapeMarkdown(change.file)} — ${escapeMarkdown(change.location)}`,
    '',
    `**Before:** ${change.before ? imageCode(change.before) : 'Not present'}`,
    `**After:** ${change.after ? imageCode(change.after) : 'Not present'}`,
    '',
  ];
  const oldPlatforms = new Map(
    before?.platforms.map((platform) => [platform.platform, platform]) ?? [],
  );
  const newPlatforms = new Map(
    after?.platforms.map((platform) => [platform.platform, platform]) ?? [],
  );
  const platforms = [
    ...new Set([...oldPlatforms.keys(), ...newPlatforms.keys()]),
  ].sort();
  if (platforms.length) {
    lines.push(
      '| Platform | Version before | Version after | Image changed |',
      '| --- | --- | --- | --- |',
    );
    for (const platform of platforms) {
      const old = oldPlatforms.get(platform);
      const next = newPlatforms.get(platform);
      let status;
      if ((!before && change.before) || (!after && change.after))
        status = 'Unknown';
      else if (!old) status = 'Added';
      else if (!next) status = 'Removed';
      else status = old.digest === next.digest ? 'No' : 'Yes';
      const oldVersion = old
        ? metadata(old.version)
        : before || !change.before
          ? 'Not present'
          : 'Not inspected';
      const newVersion = next
        ? metadata(next.version)
        : after || !change.after
          ? 'Not present'
          : 'Not inspected';
      lines.push(
        `| ${escapeMarkdown(platform)} | ${oldVersion} | ${newVersion} | ${status} |`,
      );
    }
    lines.push('');
    for (const platform of platforms) {
      const old = oldPlatforms.get(platform);
      const next = newPlatforms.get(platform);
      if (!old || !next) continue;
      for (const [field, title] of [
        ['baseName', 'Base image'],
        ['baseDigest', 'Base-image digest'],
        ['revision', 'Source revision'],
        ['source', 'Source'],
      ]) {
        if (old[field] === next[field]) continue;
        lines.push(
          `- **${escapeMarkdown(platform)} — ${title}:** ${metadata(old[field])} → ${metadata(next[field])}`,
        );
      }
    }
    if (
      before &&
      after &&
      platforms.every(
        (platform) =>
          oldPlatforms.get(platform)?.digest ===
          newPlatforms.get(platform)?.digest,
      )
    ) {
      lines.push(
        'All reported platform image digests are unchanged. The index or its non-image metadata changed.',
      );
    }
  } else {
    lines.push('No platform comparison is available.');
  }
  if (warnings.length)
    lines.push(
      '',
      ...warnings.map(
        (warning) => `- **Notice:** ${escapeMarkdown(warning, 600)}`,
      ),
    );
  lines.push('');
  return lines.join('\n');
}

export function renderReport(comparisons, { warnings = [], headSha, baseSha }) {
  const lines = [
    COMMENT_MARKER,
    '## Docker image changes',
    '',
    `Compared PR head \`${headSha}\` against merge base \`${baseSha}\`.`,
    '',
  ];
  let length = lines.join('\n').length;
  for (const [index, comparison] of comparisons.entries()) {
    const section = renderComparison(comparison);
    if (length + section.length > MAX_REPORT_LENGTH - 3000) {
      lines.push(
        `Report size limit reached; ${comparisons.length - index} image change(s) omitted. Narrow the pull request to see the remaining comparisons.`,
      );
      break;
    }
    lines.push(section);
    length += section.length + 1;
  }
  if (!comparisons.length)
    lines.push(
      'No comparable literal Docker image changes were found in supported files.',
      '',
    );
  if (warnings.length) {
    lines.push('### Discovery notices', '');
    let remaining = MAX_REPORT_LENGTH - lines.join('\n').length - 600;
    let included = 0;
    for (const warning of warnings) {
      const line = `- ${escapeMarkdown(warning, 600)}`;
      if (line.length + 1 > remaining) break;
      lines.push(line);
      remaining -= line.length + 1;
      included++;
    }
    if (included < warnings.length)
      lines.push(
        `- ${warnings.length - included} additional discovery notice(s) omitted.`,
      );
  }
  lines.push(
    '',
    'Versions are publisher-provided OCI annotations or image labels, not runtime verification. Attestation manifests are excluded from platform comparisons.',
  );
  return lines.join('\n');
}
