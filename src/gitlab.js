import { createHash } from 'node:crypto';
import { compareImages } from './compare.js';
import { discoverImages, isSupportedFile } from './discovery.js';
import { COMMENT_MARKER } from './github.js';
import { renderReport } from './report.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_REQUESTS = 2000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// Only locally authored messages reach diagnostics; never include API bodies or fetch errors.
export class GitLabError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new GitLabError(message);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\\\p{Cc}\p{Cf}]/u.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/** The API root is trusted configuration, never a URL from an MR or pagination link. */
export function createGitLabClient({
  apiUrl,
  token,
  fetch: fetchImpl = fetch,
}) {
  let root;
  try {
    root = new URL(apiUrl);
  } catch {
    throw new GitLabError('Invalid GitLab API URL.');
  }
  requireValue(
    root.protocol === 'https:' &&
      !root.username &&
      !root.password &&
      !root.search &&
      !root.hash &&
      /^\/api\/v4\/?$/.test(root.pathname),
    'GitLab API URL must be an HTTPS origin followed by /api/v4.',
  );
  requireValue(
    typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token),
    'GITLAB_TOKEN is required.',
  );
  root.pathname = '/api/v4/';
  let requests = 0;

  async function request(method, path, query = {}, body) {
    // Encode each dynamic component before constructing a route. Refuse dot segments,
    // absolute URLs and arbitrary endpoints even if an internal caller is mistaken.
    requireValue(
      /^(?:user|projects\/[^/?#]+(?:\/merge_requests(?:\/[1-9][0-9]*(?:\/versions(?:\/[1-9][0-9]*)?|\/notes(?:\/[1-9][0-9]*)?)?)?|\/repository\/files\/[^/?#]+)?)$/.test(
        path,
      ) &&
        !path
          .split('/')
          .some((part) => ['.', '..'].includes(decodeURIComponent(part))),
      'Refusing an out-of-scope GitLab API path.',
    );
    requireValue(
      method === 'GET' ||
        (method === 'POST' && /\/merge_requests\/\d+\/notes$/.test(path)) ||
        (method === 'PUT' && /\/merge_requests\/\d+\/notes\/\d+$/.test(path)),
      'Refusing an out-of-scope GitLab API operation.',
    );
    requireValue(
      ++requests <= MAX_REQUESTS,
      'GitLab API request limit exceeded.',
    );
    const url = new URL(path, root);
    requireValue(
      url.origin === root.origin && url.pathname.startsWith(root.pathname),
      'Refusing an out-of-scope GitLab API URL.',
    );
    url.search = new URLSearchParams(query).toString();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      requireValue(
        response.ok,
        `GitLab API request failed (HTTP ${response.status}).`,
      );
      const advertised = response.headers.get('content-length');
      requireValue(
        advertised === null ||
          (/^\d+$/.test(advertised) &&
            Number(advertised) <= MAX_RESPONSE_BYTES),
        'GitLab API response exceeds the size limit.',
      );
      const chunks = [];
      let length = 0;
      requireValue(response.body, 'GitLab API returned an empty response.');
      for await (const chunk of response.body) {
        length += chunk.length;
        requireValue(
          length <= MAX_RESPONSE_BYTES,
          'GitLab API response exceeds the size limit.',
        );
        chunks.push(chunk);
      }
      return {
        data: JSON.parse(Buffer.concat(chunks, length).toString('utf8')),
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof GitLabError) throw error;
      throw new GitLabError(
        'GitLab API request failed, timed out, redirected, or returned invalid JSON.',
      );
    }
  }

  return {
    async get(path, query) {
      return (await request('GET', path, query)).data;
    },
    async write(method, path, body) {
      return (await request(method, path, {}, body)).data;
    },
    async list(path, query = {}) {
      const result = [];
      const seen = new Set();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, headers } = await request('GET', path, {
          ...query,
          per_page: 100,
          page,
        });
        requireValue(
          Array.isArray(data) && data.length <= 100,
          'Invalid GitLab pagination response.',
        );
        for (const item of data) {
          requireValue(
            positiveId(item?.id) && !seen.has(item.id),
            'Duplicate or invalid GitLab pagination item.',
          );
          seen.add(item.id);
          result.push(item);
        }
        const next = headers.get('x-next-page');
        const total = headers.get('x-total');
        if (total !== null) {
          requireValue(
            /^\d+$/.test(total) &&
              Number(total) <= MAX_PAGES * 100 &&
              result.length <= Number(total),
            'Invalid or excessive GitLab pagination total.',
          );
        }
        if (next === '' || (next === null && data.length < 100)) {
          requireValue(
            total === null || result.length === Number(total),
            'Incomplete GitLab pagination response.',
          );
          return result;
        }
        requireValue(
          data.length > 0 && (next === null || next === String(page + 1)),
          'Invalid GitLab pagination continuation.',
        );
      }
      throw new GitLabError(
        'GitLab pagination limit exceeded; discovery is incomplete.',
      );
    },
  };
}

function snapshot(mr, projectId, iid, userId) {
  const refs = mr?.diff_refs;
  requireValue(
    positiveId(mr?.id) &&
      mr.iid === iid &&
      mr.project_id === projectId &&
      mr.target_project_id === projectId &&
      positiveId(mr.source_project_id) &&
      mr.author?.id === userId &&
      mr.state === 'opened' &&
      refs &&
      SHA.test(refs.base_sha) &&
      SHA.test(refs.head_sha) &&
      SHA.test(refs.start_sha) &&
      mr.sha === refs.head_sha,
    'Merge request snapshot is incomplete, mismatched, or no longer open.',
  );
  return {
    id: mr.id,
    iid,
    projectId,
    sourceProjectId: mr.source_project_id,
    headSha: refs.head_sha,
    baseSha: refs.base_sha,
    startSha: refs.start_sha,
  };
}

function matchesVersion(version, revision) {
  return (
    version?.merge_request_id === revision.id &&
    version.head_commit_sha === revision.headSha &&
    version.base_commit_sha === revision.baseSha &&
    version.start_commit_sha === revision.startSha
  );
}

async function readFile(client, projectId, path, ref) {
  const file = await client.get(
    `projects/${projectId}/repository/files/${encodeURIComponent(path)}`,
    { ref },
  );
  requireValue(
    file?.file_path === path &&
      file.ref === ref &&
      file.encoding === 'base64' &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      file.size <= MAX_FILE_BYTES &&
      typeof file.content === 'string' &&
      file.content.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4 &&
      file.content.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(file.content),
    'Repository file is oversized, invalid, or does not match the requested snapshot.',
  );
  const bytes = Buffer.from(file.content, 'base64');
  requireValue(
    bytes.length <= MAX_FILE_BYTES &&
      createHash('sha256').update(bytes).digest('hex') === file.content_sha256,
    'Repository file content failed integrity validation.',
  );
  return bytes.toString('utf8');
}

/** Compare immutable merge-base/head contents, never a moving target branch or checkout. */
export async function discoverMergeRequest(client, projectId, iid, userId) {
  const route = `projects/${projectId}/merge_requests/${iid}`;
  const revision = snapshot(await client.get(route), projectId, iid, userId);
  const versions = await client.list(`${route}/versions`);
  const selected = versions.find((version) =>
    matchesVersion(version, revision),
  );
  requireValue(
    selected,
    'No complete diff version matches the merge request snapshot.',
  );
  const version = await client.get(`${route}/versions/${selected.id}`);
  requireValue(
    version?.id === selected.id &&
      matchesVersion(version, revision) &&
      version.state === 'collected' &&
      version.overflow !== true &&
      typeof version.real_size === 'string' &&
      /^(?:0|[1-9][0-9]*)$/.test(version.real_size) &&
      Array.isArray(version.diffs) &&
      version.diffs.length <= 3000 &&
      Number(version.real_size) === version.diffs.length,
    'GitLab diff version is incomplete, truncated, overflowed, or mismatched.',
  );
  const changes = [];
  const warnings = [];
  const paths = new Set();
  let incomplete = false;
  for (const file of version.diffs) {
    requireValue(
      safePath(file?.old_path) &&
        safePath(file.new_path) &&
        typeof file.new_file === 'boolean' &&
        typeof file.deleted_file === 'boolean' &&
        typeof file.renamed_file === 'boolean' &&
        !(file.new_file && file.deleted_file) &&
        (file.renamed_file || file.old_path === file.new_path) &&
        !file.too_large &&
        !file.collapsed &&
        !paths.has(file.new_path),
      'GitLab file diff is invalid, duplicated, or truncated.',
    );
    paths.add(file.new_path);
    if (!isSupportedFile(file.old_path) && !isSupportedFile(file.new_path))
      continue;
    const before = new Map();
    const after = new Map();
    const skippedKeys = new Set();
    let readable = true;
    for (const [side, path, ref, repo, mode, absent, references] of [
      [
        'before',
        file.old_path,
        revision.baseSha,
        projectId,
        file.a_mode,
        file.new_file,
        before,
      ],
      [
        'after',
        file.new_path,
        revision.headSha,
        revision.sourceProjectId,
        file.b_mode,
        file.deleted_file,
        after,
      ],
    ]) {
      if (absent || !isSupportedFile(path)) continue;
      requireValue(
        ['100644', '100755'].includes(mode),
        'Repository definition is not a regular file.',
      );
      const content = await readFile(client, repo, path, ref);
      const found = discoverImages(path, content);
      for (const warning of found.warnings)
        warnings.push(`${path} (${side}): ${warning}`);
      for (const reference of found.references)
        references.set(reference.key, reference.image);
      for (const key of found.skippedKeys ?? []) skippedKeys.add(key);
      if (found.incomplete) readable = false;
    }
    if (!readable) {
      incomplete = true;
      warnings.push(
        `${file.new_path}: Image comparison skipped because one side could not be fully resolved.`,
      );
      continue;
    }
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (skippedKeys.has(key) || before.get(key) === after.get(key)) continue;
      changes.push({
        file: file.new_path,
        location: key,
        before: before.get(key),
        after: after.get(key),
      });
    }
  }
  return { ...revision, changes, warnings, incomplete };
}

/** Called after paginating notes, immediately before any write. */
async function assertCurrent(client, revision, userId) {
  const current = snapshot(
    await client.get(
      `projects/${revision.projectId}/merge_requests/${revision.iid}`,
    ),
    revision.projectId,
    revision.iid,
    userId,
  );
  requireValue(
    ['id', 'sourceProjectId', 'headSha', 'baseSha', 'startSha'].every(
      (key) => current[key] === revision[key],
    ),
    'Merge request changed during inspection; refusing to publish a stale comment.',
  );
}

export async function upsertMergeRequestComment(
  client,
  revision,
  userId,
  body,
  create = true,
) {
  const route = `projects/${revision.projectId}/merge_requests/${revision.iid}/notes`;
  const notes = await client.list(route, {
    order_by: 'created_at',
    sort: 'asc',
  });
  const own = notes.find(
    (note) =>
      note.author?.id === userId &&
      !note.system &&
      note.body?.startsWith(COMMENT_MARKER),
  );
  if (!own && !create) return false;
  await assertCurrent(client, revision, userId);
  if (own?.body === body) return false;
  await client.write(own ? 'PUT' : 'POST', own ? `${route}/${own.id}` : route, {
    body,
  });
  return true;
}

/** One trusted project per invocation; injected inspector is only for deterministic tests. */
export async function runGitLabReports(
  client,
  { project, allowedRegistries, maxImages = 30 },
  inspect,
) {
  requireValue(
    safePath(project) && project.includes('/'),
    'Specify one namespaced GitLab project.',
  );
  const user = await client.get('user');
  requireValue(
    positiveId(user?.id),
    'GitLab authenticated user is unavailable.',
  );
  const repository = await client.get(
    `projects/${encodeURIComponent(project)}`,
  );
  requireValue(
    positiveId(repository?.id) && repository.path_with_namespace === project,
    'GitLab project response does not match the requested scope.',
  );
  const mrs = await client.list(`projects/${repository.id}/merge_requests`, {
    state: 'opened',
    scope: 'all',
    author_id: user.id,
    order_by: 'created_at',
    sort: 'asc',
  });
  let inspected = 0;
  let written = 0;
  let incomplete = false;
  for (const mr of mrs) {
    if (mr.author?.id !== user.id || mr.state !== 'opened') continue;
    requireValue(
      positiveId(mr.iid) && mr.project_id === repository.id,
      'Merge request list escaped the requested project scope.',
    );
    const discovered = await discoverMergeRequest(
      client,
      repository.id,
      mr.iid,
      user.id,
    );
    const comparisons = await compareImages(
      discovered.changes,
      { allowedRegistries, maxImages, timeoutMs: 30_000 },
      inspect,
    );
    const report = renderReport(comparisons, discovered);
    if (
      await upsertMergeRequestComment(
        client,
        discovered,
        user.id,
        report,
        Boolean(comparisons.length || discovered.warnings.length),
      )
    )
      written++;
    inspected++;
    incomplete ||= discovered.incomplete;
  }
  requireValue(
    !incomplete,
    'Some repository definitions could not be fully parsed; see report discovery notices.',
  );
  return { inspected, written };
}
