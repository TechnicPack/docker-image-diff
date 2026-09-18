import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCurrentHead,
  COMMENT_MARKER,
  discoverPullRequest,
  upsertComment,
} from '../src/github.js';

const old = `mariadb:lts@sha256:${'a'.repeat(64)}`;
const next = `mariadb:lts@sha256:${'b'.repeat(64)}`;
const repository = { owner: 'TechnicPack', repo: 'consumer' };

function githubFixture({
  before,
  after,
  path = 'compose.yml',
  previousPath,
  status = 'modified',
}) {
  const reads = [];
  const client = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            changed_files: 1,
            base: { sha: 'base-tip' },
            head: {
              sha: 'head-sha',
              repo: { owner: { login: 'contributor' }, name: 'fork' },
            },
          },
        }),
        listFiles: () => {},
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: 'merge-base' } },
        }),
        getContent: async (request) => {
          reads.push(request);
          const text = request.ref === 'merge-base' ? before : after;
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              size: Buffer.byteLength(text),
              content: Buffer.from(text).toString('base64'),
            },
          };
        },
      },
    },
    paginate: async () => [
      { filename: path, previous_filename: previousPath, status },
    ],
  };
  return { client, reads };
}

test('compares renamed Compose services against merge base and reads fork content by immutable SHA', async () => {
  const { client, reads } = githubFixture({
    before: `services:\n  db:\n    image: ${old}\n`,
    after: `services:\n  db:\n    image: ${next}\n`,
    path: 'nested/compose.yml',
    previousPath: 'compose.yml',
    status: 'renamed',
  });
  const result = await discoverPullRequest(client, repository, 1);
  assert.deepEqual(result.changes, [
    {
      file: 'nested/compose.yml',
      location: 'service:db',
      before: old,
      after: next,
    },
  ]);
  assert.deepEqual(reads, [
    { ...repository, path: 'compose.yml', ref: 'merge-base' },
    {
      owner: 'contributor',
      repo: 'fork',
      path: 'nested/compose.yml',
      ref: 'head-sha',
    },
  ]);
});

test('unresolved service does not produce a false removal or suppress another literal update', async () => {
  const { client } = githubFixture({
    before: `services:\n  db:\n    image: ${old}\n  dynamic:\n    image: ${old}\n`,
    after: `services:\n  db:\n    image: ${next}\n  dynamic:\n    image: \${IMAGE}\n`,
  });
  const result = await discoverPullRequest(client, repository, 1);
  assert.deepEqual(
    result.changes.map((change) => change.location),
    ['service:db'],
  );
  assert.match(result.warnings.join('\n'), /dynamic|interpol|variable/i);
});

test('unreadable old content never masquerades as an added image', async () => {
  const { client } = githubFixture({
    before: '',
    after: `services:\n  db:\n    image: ${next}\n`,
  });
  const get = client.rest.repos.getContent;
  client.rest.repos.getContent = (request) =>
    request.ref === 'merge-base'
      ? Promise.reject({ status: 403 })
      : get(request);
  const result = await discoverPullRequest(client, repository, 1);
  assert.deepEqual(result.changes, []);
  assert.match(result.warnings.join('\n'), /skipped/);
});

test('does not publish results for a superseded or closed pull request', async () => {
  const client = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: 'new' }, state: 'open' } }),
      },
    },
  };
  await assert.rejects(
    assertCurrentHead(client, repository, 1, 'old'),
    /stale/,
  );
  client.rest.pulls.get = async () => ({
    data: { head: { sha: 'old' }, state: 'closed' },
  });
  await assert.rejects(
    assertCurrentHead(client, repository, 1, 'old'),
    /stale/,
  );
});

test('comment updates are idempotent and ignore marker spoofing by a user', async () => {
  const comments = [
    { id: 1, user: { login: 'contributor' }, body: `${COMMENT_MARKER}\nspoof` },
  ];
  const client = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => {},
        createComment: async ({ body }) => {
          const data = {
            id: 2,
            user: { login: 'github-actions[bot]' },
            body,
            html_url: 'https://github.com/comment/2',
          };
          comments.push(data);
          return { data };
        },
        updateComment: async ({ comment_id, body }) => {
          assert.equal(comment_id, 2);
          const data = comments.find((comment) => comment.id === comment_id);
          data.body = body;
          return { data };
        },
      },
    },
  };
  const body = `${COMMENT_MARKER}\nfirst`;
  assert.equal(
    await upsertComment(client, repository, 1, body),
    'https://github.com/comment/2',
  );
  assert.equal(comments.length, 2);
  await upsertComment(client, repository, 1, `${COMMENT_MARKER}\nupdated`);
  assert.equal(comments[1].body, `${COMMENT_MARKER}\nupdated`);
  assert.equal(comments[0].body, `${COMMENT_MARKER}\nspoof`);
  client.rest.issues.updateComment = () => {
    throw new Error('Unnecessary edit');
  };
  await upsertComment(client, repository, 1, comments[1].body);
});
