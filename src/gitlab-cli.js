import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { createGitLabClient, GitLabError, runGitLabReports } from './gitlab.js';
import { createInspector } from './registry.js';

const execute = promisify(execFile);

export function parseGitLabOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'api-url': { type: 'string' },
        project: { type: 'string' },
        'allowed-registries': { type: 'string' },
        'max-images': { type: 'string', default: '30' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new GitLabError(
      'Invalid arguments. Use --api-url, --project, --allowed-registries and optional --max-images.',
    );
  }
  const allowedRegistries = (values['allowed-registries'] ?? '')
    .split(/[,\n]/)
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    !values['api-url'] ||
    !values.project ||
    !allowedRegistries.length ||
    allowedRegistries.some(
      (host) =>
        !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/.test(host),
    )
  ) {
    throw new GitLabError(
      'Require --api-url, --project and --allowed-registries with exact lowercase registry hosts, not URLs or patterns.',
    );
  }
  const maxImages = Number(values['max-images']);
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 100) {
    throw new GitLabError('--max-images must be an integer from 1 to 100.');
  }
  return {
    apiUrl: values['api-url'],
    project: values.project,
    allowedRegistries,
    maxImages,
  };
}

/** Docker receives only runtime/registry settings, not GitLab, Renovate or CI tokens. */
export function registryEnvironment(environment) {
  const result = {};
  for (const name of [
    'PATH',
    'HOME',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  return result;
}

export async function runGitLabCli(args, environment) {
  const options = parseGitLabOptions(args);
  const client = createGitLabClient({
    apiUrl: options.apiUrl,
    token: environment.GITLAB_TOKEN,
  });
  const env = registryEnvironment(environment);
  const inspect = createInspector({
    execFile: (file, argv, settings) =>
      execute(file, argv, { ...settings, env }),
  });
  return runGitLabReports(client, options, inspect);
}
