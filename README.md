# Docker Image Diff

A GitHub Action that explains Docker image changes in pull requests. It compares pinned registry metadata and maintains one comment showing versions and platform-specific image changes.

For example, a MariaDB `lts` digest update can change only the `linux/s390x` image while leaving the MariaDB version and the AMD64 image unchanged. This action makes that distinction visible without pulling image layers or running containers.

[Example report](https://github.com/TechnicPack/docker-image-diff/pull/1#issuecomment-5735377509) · [Releases](https://github.com/TechnicPack/docker-image-diff/releases) · [MIT license](LICENSE)

## Quick start

Add this workflow to `.github/workflows/docker-image-diff.yml` in the consuming repository:

```yaml
name: Describe Docker image updates

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: docker-image-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  describe:
    if: github.event.pull_request.user.login == 'renovate[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: TechnicPack/docker-image-diff@v1
```

The action uses the workflow's `GITHUB_TOKEN` automatically. No checkout, personal access token, or additional secret is needed for public images.

For production, pin the action to the full commit SHA of a release rather than the movable `v1` tag. Renovate can maintain that action pin. A copyable workflow with configuration notes is available in [examples/renovate.yml](examples/renovate.yml).

**Do not check out or execute PR code in this privileged workflow.** The action reads files as data through GitHub's API. Keep the per-PR concurrency group so runs do not race to create separate comments.

### Other bots and human PRs

The action is not Renovate-specific. Bot filtering belongs to the caller: change the job's `if` condition for a different bot, or remove it to report on all PRs. Filter on `github.event.pull_request.user.login`, not the user who happens to trigger a rerun.

### Read-only reports

Set `comment: 'false'` to produce only the job summary and step outputs. The workflow then needs `contents: read` and `pull-requests: read`, rather than comment-writing permission. It can use the `pull_request` event, provided the token can read the relevant repository files.

```yaml
- uses: TechnicPack/docker-image-diff@v1
  with:
    comment: 'false'
```

## What the comment shows

For each distinct before/after image transition:

- All affected files, Compose services or Dockerfile stages, and before/after references.
- Each platform's version metadata and whether its image manifest digest changed.
- Changes to published base-image names/digests and source revisions/URLs.
- Explicit notices for unsupported references, missing metadata, or failed inspections.

Identical before/after references share one comparison, with every affected location listed. Different source or destination references remain separate.

A typical comparison looks like this:

| Platform | Version before | Version after | Image changed |
| --- | --- | --- | --- |
| `linux/amd64` | `12.3.3-noble` | `12.3.3-noble` | No |
| `linux/arm64/v8` | `12.3.3-noble` | `12.3.3-noble` | No |
| `linux/s390x` | `12.3.3-noble` | `12.3.3-noble` | Yes |

The action compares the PR head with its merge base, not an unrelated newer base-branch version. It updates its existing comment after subsequent pushes and refuses to publish when the PR head changed or the PR closed during inspection. If a later push removes all relevant changes, an existing comment is updated to say so; unrelated PRs do not receive a new empty comment.

A successful workflow means the report was generated, **not** that an image update is safe or that every registry lookup succeeded. Inspect the report's notices. Versions are publisher-provided annotations or labels, not values obtained by executing the software.

## Supported files and images

Supported files can be nested in the repository:

| File | Discovery |
| --- | --- |
| `compose.yml`, `compose.yaml`, `compose.*.yml`, `compose.*.yaml` | Service `image` fields, including YAML merges |
| `docker-compose*.yml`, `docker-compose*.yaml` | Service `image` fields, including YAML merges |
| `Dockerfile`, `Dockerfile.*`, `*.Dockerfile` | Literal `FROM` references, including named stages and backslash continuations |

Dockerfile references to earlier stages and `scratch` are excluded. Compose services are paired by name, and Dockerfile stages by alias or unnamed-stage position. Renamed files are supported.

Registry inspection supports OCI image indexes, Docker manifest lists, nested indexes, and single-platform manifests. Platforms retain architecture variants and Windows OS versions. Attestation manifests are excluded from runnable-platform comparisons.

### Digest pins are required

Only `sha256`-pinned images are inspected. A tag such as `node:24`, `mariadb:lts`, or even `node:24.20.0-slim` can be overwritten: resolving it today cannot establish which image existed before a PR.

- **Both sides pinned:** compare both exact images.
- **Only one side pinned:** inspect that side; the unavailable comparison remains unknown.
- **Neither side pinned:** show the changed references and explain that no historical image comparison is available. Do not look up moving tags and present them as historical versions.
- **Missing version annotations/labels:** report “Not provided,” without deriving a version from the tag or container environment variables.
- **Coarse version metadata:** some publishers report a channel such as `24-alpine`, not an exact software version. The report preserves that metadata rather than inventing greater precision.

Keeping a moving channel such as `lts` alongside a digest works well: Renovate continues following the channel, and the action reports the exact old and new images.

### Deliberate limitations

- No evaluation of Dockerfile `ARG`, environment variables, Compose interpolation, or `.env` files.
- Unsupported Dockerfile heredocs or escape directives are reported rather than interpreted. Heredoc-looking instructions are handled conservatively.
- No arbitrary Kubernetes, Helm, build-script, or CI-image extraction.
- Individual definition files are limited to 1 MiB. YAML alias expansion, registry command output, inspection time, and manifest traversal are bounded.
- Oversized PRs that GitHub cannot list completely are rejected. Large reports are truncated with an explicit notice.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | GitHub token with repository contents read and PR read/write access as appropriate |
| `allowed-registries` | `docker.io,ghcr.io,quay.io` | Comma- or newline-separated exact registry hosts approved for inspection |
| `comment` | `true` | Whether to create or update the PR comment |
| `max-images` | `30` | Maximum unique pinned image references to inspect; integer from 1 to 100 |

Registry names are not URL patterns or wildcards. Nondefault ports must be explicitly included in the allowlist. Docker Hub's standard hostname aliases normalize to `docker.io`.

## Outputs

| Output | Description |
| --- | --- |
| `changes` | Number of changed literal image references discovered |
| `comment-url` | URL of the maintained comment, or empty when commenting is disabled or unnecessary |
| `report` | The generated Markdown report, also written to the job summary |

## Runner requirements and security

Use a Node.js 24-compatible GitHub Actions runner with Docker CLI and Buildx installed. GitHub-hosted `ubuntu-latest` supplies these tools. The action uses `docker buildx imagetools inspect`; it does not build, pull image layers, or run a container.

PR files and image metadata are untrusted input. The implementation uses shell-free subprocess arguments, validates image references, restricts registry hosts, verifies raw manifest digests, and neutralizes publisher-supplied Markdown and mentions. It does not execute repository scripts or resolve local Compose environments.

The registry allowlist restricts image reference hosts. It is **not** a network sandbox: Docker still handles authentication endpoints, CDN redirects, and any mirrors configured on the runner. Only allow trusted registries and use a trusted runner configuration.

For private images, authenticate with a trusted registry-login action before this action and explicitly allow that registry host. Scope credentials to the required registry; do not forward unrelated secrets. The caller remains responsible for deciding which PRs may use those credentials. The default comment identity is `github-actions[bot]`; use the workflow's `GITHUB_TOKEN` rather than a personal token to maintain the same comment identity.

## Development

Use Node.js 24 or newer:

```sh
npm ci
npm run check
npm test
npm run build
```

The action executes the committed `dist/index.cjs` bundle. Include regenerated bundle changes with source/dependency changes. CI checks lint, regression tests, and that rebuilding produces the committed bundle.

Renovate manages npm dependencies and GitHub Actions using `config:best-practices`. For dependency PRs, run `npm ci` and `npm run build` on a trusted workstation after reviewing the changes, and commit any bundle changes to the PR branch. CI deliberately rejects a stale bundle rather than running untrusted PR code with write permissions.

Tests cover parsing ambiguity, unresolved variables, registry boundaries, missing metadata, platform matching, safe rendering, and comment updates. Registry fixtures make the unit suite deterministic; live comparisons are separate from the unit suite.

## License

[MIT](LICENSE). Copyright © 2026 Syndicate LLC.
