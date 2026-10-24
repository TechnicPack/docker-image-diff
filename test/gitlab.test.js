import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { COMMENT_MARKER } from '../src/github.js';
import {
  createGitLabClient,
  discoverMergeRequest,
  runGitLabReports,
  upsertMergeRequestComment,
} from '../src/gitlab.js';
import { parseGitLabOptions, registryEnvironment } from '../src/gitlab-cli.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const targetTip = 'c'.repeat(40);
const old = `mariadb:lts@sha256:${'1'.repeat(64)}`;
const next = `mariadb:lts@sha256:${'2'.repeat(64)}`;
const apiUrl = 'https://git.example.test/api/v4';
const options = {
  project: 'technic/platformapi',
  allowedRegistries: ['docker.io'],
};

function json(data, headers = {}) {
  return new Response(JSON.stringify(data), { headers });
}

function fixture() {
  const state = {
    mr: {
      id: 71,
      iid: 2,
      project_id: 12,
      target_project_id: 12,
      source_project_id: 19,
      author: { id: 10 },
      state: 'opened',
      sha: head,
      diff_refs: { base_sha: base, head_sha: head, start_sha: targetTip },
    },
    version: {
      id: 90,
      merge_request_id: 71,
      state: 'collected',
      real_size: '1',
      base_commit_sha: base,
      head_commit_sha: head,
      start_commit_sha: targetTip,
      diffs: [
        {
          old_path: 'compose.yml',
          new_path: 'nested/compose.yml',
          new_file: false,
          deleted_file: false,
          renamed_file: true,
          a_mode: '100644',
          b_mode: '100644',
          diff: '',
        },
      ],
    },
    before: `services:\n  db:\n    image: ${old}\n`,
    after: `services:\n  db:\n    image: ${next}\n`,
    notes: [],
    writes: [],
    reads: [],
    calls: [],
    listed: undefined,
    fileTransform: (file) => file,
    beforeCurrent: () => {},
  };
  let mrReads = 0;
  state.fetch = async (input, init) => {
    const url = new URL(input);
    state.calls.push({ url, init });
    assert.equal(url.origin, 'https://git.example.test');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['PRIVATE-TOKEN'], 'private-test-token');
    const path = decodeURIComponent(url.pathname.slice('/api/v4/'.length));
    if (path === 'user') return json({ id: 10 });
    if (path === 'projects/technic/platformapi')
      return json({ id: 12, path_with_namespace: 'technic/platformapi' });
    if (path === 'projects/12/merge_requests') {
      assert.equal(url.searchParams.get('author_id'), '10');
      assert.equal(url.searchParams.get('state'), 'opened');
      return json(state.listed ?? [state.mr], { 'x-next-page': '' });
    }
    if (path === 'projects/12/merge_requests/2') {
      if (++mrReads > 1) state.beforeCurrent();
      return json(state.mr);
    }
    if (path === 'projects/12/merge_requests/2/versions')
      return json([state.version], { 'x-next-page': '' });
    if (path === 'projects/12/merge_requests/2/versions/90')
      return json(state.version);
    const fileMatch = /^projects\/(12|19)\/repository\/files\/(.+)$/.exec(path);
    if (fileMatch) {
      const ref = url.searchParams.get('ref');
      state.reads.push({
        project: Number(fileMatch[1]),
        path: fileMatch[2],
        ref,
      });
      const text = ref === base ? state.before : state.after;
      return json(
        state.fileTransform({
          file_path: fileMatch[2],
          ref,
          encoding: 'base64',
          content: Buffer.from(text).toString('base64'),
          size: Buffer.byteLength(text),
          content_sha256: createHash('sha256').update(text).digest('hex'),
        }),
      );
    }
    if (
      path === 'projects/12/merge_requests/2/notes' &&
      init.method === 'GET'
    ) {
      return json(state.notes, { 'x-next-page': '' });
    }
    if (
      path.startsWith('projects/12/merge_requests/2/notes') &&
      ['PUT', 'POST'].includes(init.method)
    ) {
      const { body } = JSON.parse(init.body);
      state.writes.push({ path, method: init.method, body });
      const own =
        init.method === 'PUT'
          ? state.notes.find((note) => path.endsWith(`/${note.id}`))
          : undefined;
      if (own) own.body = body;
      else
        state.notes.push({ id: 700, author: { id: 10 }, body, system: false });
      return json(own ?? state.notes.at(-1));
    }
    throw new Error('Unexpected fixture route');
  };
  state.client = createGitLabClient({
    apiUrl,
    token: 'private-test-token',
    fetch: (...args) => state.fetch(...args),
  });
  return state;
}

const noInspection = async () => {
  throw new Error('Registry unavailable');
};

test('reads renamed files from immutable merge base and fork head, not target tip', async () => {
  const f = fixture();
  const result = await discoverMergeRequest(f.client, 12, 2, 10);
  assert.deepEqual(result.changes, [
    {
      file: 'nested/compose.yml',
      location: 'service:db',
      before: old,
      after: next,
    },
  ]);
  assert.equal(result.baseSha, base);
  assert.deepEqual(f.reads, [
    { project: 12, path: 'compose.yml', ref: base },
    { project: 19, path: 'nested/compose.yml', ref: head },
  ]);
});

test('added and deleted definitions never request their absent sides', async () => {
  for (const added of [true, false]) {
    const f = fixture();
    Object.assign(f.version.diffs[0], {
      old_path: 'compose.yml',
      new_path: 'compose.yml',
      renamed_file: false,
      new_file: added,
      deleted_file: !added,
    });
    const result = await discoverMergeRequest(f.client, 12, 2, 10);
    assert.equal(f.reads.length, 1);
    assert.equal(result.changes[0].before, added ? undefined : old);
    assert.equal(result.changes[0].after, added ? next : undefined);
  }
});

test('skipped dynamic expressions preserve other literal changes without false removals', async () => {
  const f = fixture();
  f.before += `  dynamic:\n    image: ${old}\n`;
  f.after += `  dynamic:\n    image: \${IMAGE}\n`;
  const result = await discoverMergeRequest(f.client, 12, 2, 10);
  assert.deepEqual(
    result.changes.map((change) => change.location),
    ['service:db'],
  );
  assert.match(result.warnings.join('\n'), /dynamic|interpol|variable/i);
});

test('incomplete parsing publishes notices but fails the invocation without invented changes', async () => {
  const f = fixture();
  f.after = 'services: [broken';
  await assert.rejects(
    runGitLabReports(f.client, options, noInspection),
    /fully parsed/,
  );
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].body, /Discovery notices|skipped/);
  assert.doesNotMatch(f.writes[0].body, /\*\*Before:\*\*/);
});

test('rejects uncollected, overflowed, truncated and mismatched immutable diff snapshots', async () => {
  const changes = [
    (f) => {
      f.version.state = 'overflow';
    },
    (f) => {
      f.version.state = 'without_files';
    },
    (f) => {
      f.version.overflow = true;
    },
    (f) => {
      f.version.real_size = '2';
    },
    (f) => {
      f.version.real_size = '1000+';
    },
    (f) => {
      f.version.head_commit_sha = targetTip;
    },
    (f) => {
      f.version.base_commit_sha = targetTip;
    },
    (f) => {
      f.version.diffs[0].too_large = true;
    },
    (f) => {
      f.version.diffs[0].collapsed = true;
    },
    (f) => {
      f.version.diffs.push(f.version.diffs[0]);
      f.version.real_size = '2';
    },
    (f) => {
      f.mr.sha = targetTip;
    },
    (f) => {
      f.mr.diff_refs = null;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(
      runGitLabReports(f.client, options, noInspection),
      /snapshot|diff|version/i,
    );
    assert.equal(f.writes.length, 0);
  }
});

test('rejects unsafe file paths, nonregular files and wrong or corrupt file responses', async () => {
  const changes = [
    (f) => {
      f.version.diffs[0].new_path = '../Dockerfile';
    },
    (f) => {
      f.version.diffs[0].b_mode = '120000';
    },
    (f) => {
      f.fileTransform = (file) => ({ ...file, ref: targetTip });
    },
    (f) => {
      f.fileTransform = (file) => ({ ...file, file_path: 'other.yml' });
    },
    (f) => {
      f.fileTransform = (file) => ({ ...file, content_sha256: '0'.repeat(64) });
    },
    (f) => {
      f.fileTransform = (file) => ({ ...file, content: 'invalid!' });
    },
    (f) => {
      f.fileTransform = (file) => ({ ...file, size: 1024 * 1024 + 1 });
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(
      runGitLabReports(f.client, options, noInspection),
      /file|definition/i,
    );
    assert.equal(f.writes.length, 0);
  }
});

test('rechecks open state, author, fork and base/head/start after note discovery before writing', async () => {
  for (const change of [
    (mr) => {
      mr.state = 'closed';
    },
    (mr) => {
      mr.author.id = 11;
    },
    (mr) => {
      mr.source_project_id = 20;
    },
    (mr) => {
      mr.sha = targetTip;
      mr.diff_refs.head_sha = targetTip;
    },
    (mr) => {
      mr.diff_refs.base_sha = targetTip;
    },
    (mr) => {
      mr.diff_refs.start_sha = base;
    },
  ]) {
    const f = fixture();
    f.beforeCurrent = () => change(f.mr);
    await assert.rejects(
      runGitLabReports(f.client, options, noInspection),
      /snapshot|stale/,
    );
    assert.equal(f.writes.length, 0);
    assert.match(f.calls.at(-2).url.pathname, /\/notes$/);
    assert.match(f.calls.at(-1).url.pathname, /\/merge_requests\/2$/);
  }
});

test('filters authors by authenticated identity and ignores unrelated open MRs', async () => {
  const f = fixture();
  f.listed = [
    { ...f.mr, id: 72, iid: 3, author: { id: 11 } },
    { ...f.mr, id: 73, iid: 4, state: 'closed' },
    f.mr,
  ];
  assert.deepEqual(await runGitLabReports(f.client, options, noInspection), {
    inspected: 1,
    written: 1,
  });
  assert.equal(
    f.calls.some(({ url }) =>
      /merge_requests\/[34](?:\/|$)/.test(url.pathname),
    ),
    false,
  );
});

test('bot-owned comments are idempotent and human or system marker notes are not overwritten', async () => {
  const f = fixture();
  f.notes.push(
    { id: 600, author: { id: 11 }, body: `${COMMENT_MARKER}\nhuman` },
    {
      id: 601,
      author: { id: 10 },
      body: `${COMMENT_MARKER}\nsystem`,
      system: true,
    },
  );
  const revision = await discoverMergeRequest(f.client, 12, 2, 10);
  const body = `${COMMENT_MARKER}\nreport`;
  assert.equal(
    await upsertMergeRequestComment(f.client, revision, 10, body),
    true,
  );
  assert.equal(
    await upsertMergeRequestComment(f.client, revision, 10, body),
    false,
  );
  assert.equal(
    await upsertMergeRequestComment(f.client, revision, 10, `${body} updated`),
    true,
  );
  assert.deepEqual(
    f.writes.map(({ method }) => method),
    ['POST', 'PUT'],
  );
  assert.match(f.writes[1].path, /\/notes\/700$/);
  assert.equal(f.notes[0].body, `${COMMENT_MARKER}\nhuman`);
  assert.equal(f.notes[1].body, `${COMMENT_MARKER}\nsystem`);
});

test('removal of image changes updates an existing report and never creates an empty report', async () => {
  const f = fixture();
  await runGitLabReports(f.client, options, noInspection);
  f.after = f.before;
  await runGitLabReports(f.client, options, noInspection);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].method, 'PUT');
  assert.match(f.writes[1].body, /No comparable literal Docker image changes/);
  f.notes = [];
  await runGitLabReports(f.client, options, noInspection);
  assert.equal(f.writes.length, 2);
});

test('unsupported CI-only changes receive no empty note and no repository reads', async () => {
  const f = fixture();
  Object.assign(f.version.diffs[0], {
    old_path: '.gitlab-ci.yml',
    new_path: '.gitlab-ci.yml',
    renamed_file: false,
  });
  assert.deepEqual(await runGitLabReports(f.client, options, noInspection), {
    inspected: 1,
    written: 0,
  });
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

test('fully paginates lists without following untrusted Link URLs', async () => {
  const pages = [];
  const client = createGitLabClient({
    apiUrl,
    token: 'private-test-token',
    fetch: async (url) => {
      pages.push(url);
      const page = Number(url.searchParams.get('page'));
      return json([{ id: page }], {
        'x-next-page': page === 1 ? '2' : '',
        'x-total': '2',
        link: '<https://attacker.test/steal>; rel="next"',
      });
    },
  });
  assert.deepEqual(await client.list('projects/12/merge_requests'), [
    { id: 1 },
    { id: 2 },
  ]);
  assert.deepEqual(
    pages.map((url) => url.searchParams.get('page')),
    ['1', '2'],
  );
  assert.ok(pages.every((url) => url.origin === 'https://git.example.test'));
});

test('missing pagination headers request another page after a full page', async () => {
  let requests = 0;
  const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const client = createGitLabClient({
    apiUrl,
    token: 't',
    fetch: async () => json(++requests === 1 ? first : [{ id: 101 }]),
  });
  assert.equal((await client.list('projects/12/merge_requests')).length, 101);
  assert.equal(requests, 2);
});

test('fails on pagination truncation, duplicate entries, looping continuation and page cap', async () => {
  for (const mode of ['truncated', 'duplicate', 'loop', 'cap']) {
    const client = createGitLabClient({
      apiUrl,
      token: 't',
      fetch: async (url) => {
        const page = Number(url.searchParams.get('page'));
        return json([{ id: mode === 'duplicate' ? 1 : page }], {
          'x-next-page':
            mode === 'truncated'
              ? ''
              : mode === 'loop'
                ? '1'
                : String(page + 1),
          ...(mode === 'truncated' ? { 'x-total': '2' } : {}),
        });
      },
    });
    await assert.rejects(
      client.list('projects/12/merge_requests'),
      /pagination/i,
    );
  }
});

test('bounded fetch rejects oversized responses, redirects and errors without leaking diagnostics', async () => {
  for (const fetchImpl of [
    async () => new Response('private-test-token', { status: 403 }),
    async () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://attacker.test' },
      }),
    async () => json({}, { 'content-length': String(8 * 1024 * 1024 + 1) }),
    async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    async () => {
      throw new Error('private-test-token');
    },
  ]) {
    const client = createGitLabClient({
      apiUrl,
      token: 'private-test-token',
      fetch: fetchImpl,
    });
    await assert.rejects(client.get('user'), (error) => {
      assert.doesNotMatch(error.message, /private-test-token|attacker/);
      return true;
    });
  }
});

test('refuses non-HTTPS roots, credentials, arbitrary routes and non-note writes', async () => {
  for (const root of [
    'http://git.example.test/api/v4',
    'https://user:secret@git.example.test/api/v4',
    `${apiUrl}?token=secret`,
    `${apiUrl}/../other`,
  ]) {
    assert.throws(
      () => createGitLabClient({ apiUrl: root, token: 't' }),
      /API URL/,
    );
  }
  let requests = 0;
  const client = createGitLabClient({
    apiUrl,
    token: 't',
    fetch: async () => {
      requests++;
      return json({});
    },
  });
  for (const path of [
    'https://attacker.test',
    '../user',
    'projects/../user',
    'projects/12/pipelines',
    'projects/12/merge_requests/2/merge',
  ]) {
    await assert.rejects(client.get(path), /out-of-scope/);
  }
  await assert.rejects(
    client.write('PUT', 'projects/12/merge_requests/2', {}),
    /out-of-scope/,
  );
  assert.equal(requests, 0);
});

test('API failures while reading files fail discovery instead of inventing image additions', async () => {
  const f = fixture();
  const fetchImpl = f.fetch;
  f.fetch = (url, init) =>
    url.pathname.includes('/repository/files/')
      ? new Response('secret', { status: 404 })
      : fetchImpl(url, init);
  await assert.rejects(
    runGitLabReports(f.client, options, noInspection),
    /HTTP 404/,
  );
  assert.equal(f.writes.length, 0);
});

test('CLI requires explicit project and registry scope and defaults to thirty images', () => {
  const args = [
    '--api-url',
    apiUrl,
    '--project',
    'technic/platformapi',
    '--allowed-registries',
    'docker.io',
  ];
  assert.deepEqual(parseGitLabOptions(args), {
    apiUrl,
    ...options,
    maxImages: 30,
  });
  assert.throws(
    () => parseGitLabOptions([...args, '--max-images', '101']),
    /1 to 100/,
  );
  assert.throws(
    () => parseGitLabOptions([...args, '--token', 'private-test-token']),
    (error) => !error.message.includes('private-test-token'),
  );
  assert.throws(() => parseGitLabOptions(args.slice(0, -2)), /Require/);
  assert.throws(
    () => parseGitLabOptions([...args.slice(0, -1), 'https://docker.io']),
    /registry/,
  );
});

test('Docker environment excludes custom credentials while retaining explicit runtime settings', () => {
  assert.deepEqual(
    registryEnvironment({
      PATH: '/bin',
      HOME: '/home/bot',
      DOCKER_CONFIG: '/trusted/docker',
      GITLAB_TOKEN: 'secret',
      RENOVATE_TOKEN: 'secret',
      CI_JOB_TOKEN: 'secret',
      CUSTOM_SECRET: 'secret',
    }),
    { PATH: '/bin', HOME: '/home/bot', DOCKER_CONFIG: '/trusted/docker' },
  );
});
