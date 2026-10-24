import { GitLabError } from './gitlab.js';
import { runGitLabCli } from './gitlab-cli.js';

runGitLabCli(process.argv.slice(2), process.env).then(
  ({ inspected, written }) => {
    console.log(
      `Inspected ${inspected} bot merge request(s); wrote ${written} report(s).`,
    );
  },
  (error) => {
    // Unexpected errors can contain request metadata or credentials; never print them.
    console.error(
      error instanceof GitLabError
        ? error.message
        : 'GitLab image reporting failed.',
    );
    process.exitCode = 1;
  },
);
