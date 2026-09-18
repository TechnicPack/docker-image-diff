import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { compareImages } from './compare.js';
import {
  assertCurrentHead,
  discoverPullRequest,
  upsertComment,
} from './github.js';
import { renderReport } from './report.js';

async function run() {
  if (
    !['pull_request', 'pull_request_target'].includes(context.eventName) ||
    !context.payload.pull_request
  ) {
    throw new Error(
      'Run this action from a pull_request or pull_request_target workflow',
    );
  }
  const token = core.getInput('github-token', { required: true });
  core.setSecret(token);
  const client = getOctokit(token);
  const repository = context.repo;
  const number = context.payload.pull_request.number;
  const allowedRegistries = core
    .getInput('allowed-registries')
    .split(/[,\n]/)
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    !allowedRegistries.length ||
    allowedRegistries.some(
      (host) =>
        !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/.test(host),
    )
  ) {
    throw new Error(
      'allowed-registries must contain exact lowercase registry hosts, optionally with ports, not URLs or patterns',
    );
  }
  const maxImages = Number(core.getInput('max-images'));
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 100)
    throw new Error('max-images must be an integer from 1 to 100');
  const comment = core.getBooleanInput('comment');
  const discovered = await discoverPullRequest(client, repository, number);
  const comparisons = await compareImages(discovered.changes, {
    allowedRegistries,
    maxImages,
    timeoutMs: 30000,
  });
  const report = renderReport(comparisons, discovered);
  core.setOutput('changes', discovered.changes.length);
  core.setOutput('report', report);
  await core.summary.addRaw(report).write();
  let url = '';
  if (comment) {
    await assertCurrentHead(client, repository, number, discovered.headSha);
    url = await upsertComment(
      client,
      repository,
      number,
      report,
      Boolean(comparisons.length || discovered.warnings.length),
    );
  }
  core.setOutput('comment-url', url);
  core.info(
    `Compared ${discovered.changes.length} image reference change(s).${url ? ` Report: ${url}` : ''}`,
  );
}

run().catch((error) => {
  // GitHub API errors can embed request metadata. Do not log request objects or tokens.
  core.setFailed(
    error.status
      ? `GitHub API request failed (HTTP ${error.status}). Check token permissions and repository access.`
      : error.message,
  );
});
