import { inspectImage, parseImage } from './registry.js';

/** @returns {Promise<import('./types.js').Comparison[]>} */
export async function compareImages(changes, options, inspect = inspectImage) {
  const cache = new Map();
  async function resolve(reference, side, warnings) {
    if (!reference) return undefined;
    let image;
    try {
      image = parseImage(reference);
    } catch {
      warnings.push(
        `${side}: Invalid or unresolved image reference; not inspected.`,
      );
      return undefined;
    }
    if (!image.digest) {
      warnings.push(
        `${side}: No immutable digest is pinned. A moving tag cannot establish the historical image; not inspected.`,
      );
      return undefined;
    }
    const key = `${image.registry}/${image.repository}@${image.digest}`;
    if (!cache.has(key)) {
      if (cache.size >= options.maxImages) {
        warnings.push(
          `${side}: Inspection limit reached (${options.maxImages} unique images).`,
        );
        return undefined;
      }
      cache.set(
        key,
        inspect(reference, options).then(
          (result) => ({ result }),
          () => ({ error: true }),
        ),
      );
    }
    const response = await cache.get(key);
    if (response.error) {
      warnings.push(
        `${side}: Registry inspection failed or was rejected. Check the registry allowlist, image availability, authentication, and Docker Buildx installation.`,
      );
      return undefined;
    }
    for (const warning of response.result.warnings)
      warnings.push(`${side}: ${warning}`);
    return response.result;
  }
  const results = [];
  // Serial inspection bounds registry load and runner resource use.
  for (const change of changes) {
    const warnings = [];
    const before = await resolve(change.before, 'Before', warnings);
    const after = await resolve(change.after, 'After', warnings);
    results.push({ change, before, after, warnings });
  }
  return results;
}
