import { discoverImages, isSupportedFile } from './discovery.js';

const MAX_FILE_BYTES = 1024 * 1024;
export const COMMENT_MARKER = '<!-- technicpack/docker-image-diff -->';

/** Read file bytes through the API. Never check out or evaluate pull request code. */
async function readFile(client, repository, path, ref) {
  const { data } = await client.rest.repos.getContent({
    ...repository,
    path,
    ref,
  });
  if (
    Array.isArray(data) ||
    data.type !== 'file' ||
    data.encoding !== 'base64'
  ) {
    throw new Error(
      'Not a regular, API-readable file (symlinks and submodules are not followed)',
    );
  }
  if (data.size > MAX_FILE_BYTES)
    throw new Error('File exceeds the 1 MiB limit');
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length > MAX_FILE_BYTES)
    throw new Error('File exceeds the 1 MiB limit');
  return bytes.toString('utf8');
}

/** @returns {Promise<{changes: import('./types.js').ImageChange[], warnings: string[], headSha: string, baseSha: string}>} */
export async function discoverPullRequest(client, repository, number) {
  const { data: pr } = await client.rest.pulls.get({
    ...repository,
    pull_number: number,
  });
  if (!pr.head.repo)
    throw new Error('The pull request head repository is unavailable');
  if (pr.changed_files > 3000)
    throw new Error(
      'GitHub cannot list every file in PRs with more than 3000 changed files',
    );
  const headRepository = {
    owner: pr.head.repo.owner.login,
    repo: pr.head.repo.name,
  };
  const { data: comparison } =
    await client.rest.repos.compareCommitsWithBasehead({
      ...repository,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
      per_page: 1,
    });
  const baseSha = comparison.merge_base_commit.sha;
  const files = await client.paginate(client.rest.pulls.listFiles, {
    ...repository,
    pull_number: number,
    per_page: 100,
  });
  if (files.length !== pr.changed_files)
    throw new Error(
      'Pull request file list changed or is incomplete; rerun the action',
    );
  const changes = [];
  const warnings = [];
  for (const file of files) {
    const previousPath = file.previous_filename ?? file.filename;
    if (!isSupportedFile(file.filename) && !isSupportedFile(previousPath))
      continue;
    const before = new Map();
    const after = new Map();
    const skippedKeys = new Set();
    let readable = true;
    for (const [side, path, ref, repo, references] of [
      ['before', previousPath, baseSha, repository, before],
      ['after', file.filename, pr.head.sha, headRepository, after],
    ]) {
      if (
        (side === 'before' && file.status === 'added') ||
        (side === 'after' && file.status === 'removed')
      )
        continue;
      if (!isSupportedFile(path)) continue;
      try {
        const content = await readFile(client, repo, path, ref);
        const found = discoverImages(path, content);
        for (const warning of found.warnings)
          warnings.push(`${path} (${side}): ${warning}`);
        for (const reference of found.references)
          references.set(reference.key, reference.image);
        for (const key of found.skippedKeys ?? []) skippedKeys.add(key);
        if (found.incomplete) readable = false;
      } catch (error) {
        warnings.push(
          `${path} (${side}): Could not read file (${error.status ?? 'invalid file'}).`,
        );
        readable = false;
      }
    }
    if (!readable) {
      warnings.push(
        `${file.filename}: Image comparison skipped because one side could not be fully resolved.`,
      );
      continue;
    }
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (skippedKeys.has(key)) continue;
      if (before.get(key) === after.get(key)) continue;
      changes.push({
        file: file.filename,
        location: key,
        before: before.get(key),
        after: after.get(key),
      });
    }
  }
  return { changes, warnings, headSha: pr.head.sha, baseSha };
}

/** Prevent stale runs overwriting the report for a newer PR revision. */
export async function assertCurrentHead(client, repository, number, headSha) {
  const { data } = await client.rest.pulls.get({
    ...repository,
    pull_number: number,
  });
  if (data.head.sha !== headSha || data.state !== 'open') {
    throw new Error(
      'Pull request changed or closed during inspection; refusing to publish a stale comment',
    );
  }
}

export async function upsertComment(
  client,
  repository,
  number,
  body,
  create = true,
) {
  const comments = await client.paginate(client.rest.issues.listComments, {
    ...repository,
    issue_number: number,
    per_page: 100,
  });
  // Do not edit a user-authored comment merely because it contains our marker.
  const own = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.startsWith(COMMENT_MARKER),
  );
  if (own) {
    if (own.body === body) return own.html_url;
    const { data } = await client.rest.issues.updateComment({
      ...repository,
      comment_id: own.id,
      body,
    });
    return data.html_url;
  }
  if (!create) return '';
  const { data } = await client.rest.issues.createComment({
    ...repository,
    issue_number: number,
    body,
  });
  return data.html_url;
}
