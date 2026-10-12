# Multi-repository fork

This is an unofficial fork of [github/vscode-github-actions](https://github.com/github/vscode-github-actions), maintained in [NNN706/vscode-github-actions](https://github.com/NNN706/vscode-github-actions).

## Install

1. Disable the official **GitHub Actions** extension (`GitHub.vscode-github-actions`) in this workspace. Both extensions use the same command and view IDs and must not run together.
2. Run **Extensions: Install from VSIX...**, select the supplied VSIX, then reload VS Code.
3. Open your existing parent folder or `.code-workspace`, sign in to GitHub, and open the GitHub Actions sidebar.

Keep your existing workspace settings. For example, the parent can be a non-Git directory:

```text
Lotrepair/                       # not a Git repository
  infra/.git/
  infra/.github/workflows/ci.yml
  Twenty/.git/
  Twenty/.github/workflows/ci.yml
```

The Workflows, Current Branch, and Settings views display each repository under `owner/name`. Hover over the repository to see its local path. A single repository keeps the original flat view.

## Behavior

- Uses all repositories discovered by VS Code Git, including nested repositories and worktrees.
- Additionally opens explicit workspace roots and nested directories containing `.github/workflows/*.yml` or `*.yaml` when a `.git` directory or file is present. Discovery requires a trusted workspace, honors VS Code search ignore rules, and excludes dependency/build directories. Repositories without checked-out workflows can be added as workspace folders or opened through VS Code Git.
- Refresh repeats discovery. Git open/close events update the views without reopening a repository just closed by the user. Workspace changes and newly created workflow files also trigger discovery.
- Branch and remote changes refresh the repository context. Subscriptions are disposed on repository close and extension shutdown.
- Workflow file lookup uses the deepest matching repository root. Dispatch uses that repository's branch and a repository-relative workflow path.
- Pinned workflow paths resolve against their actual repository, including projects beneath a non-Git workspace root.
- Supports fetch-only and SSH remotes; parses hostnames rather than matching a substring. Enterprise remotes must match the configured enterprise host.
- A repository metadata lookup failure does not hide healthy repositories. Details appear in **Output → GitHub Actions**; Refresh retries failed repositories.
- Supports multiple virtual GitHub workspace folders.

## Development and validation

```sh
npm ci
npm test -- --runInBand
npm run lint
npx tsc --noEmit
npm run build
npx vsce package --no-dependencies --out github-actions-multi-repo.vsix
```

`skipLibCheck` excludes incompatible upstream dependency declarations (`@types/ws` and browser JSON-RPC worker types) from checking; extension source remains under strict TypeScript checking.

Tests use mocked VS Code and GitHub APIs. Manual acceptance in a signed-in VS Code window is still required: open a non-Git parent with two child repositories, expand both repositories in each sidebar view, switch their branches independently, and verify the proposed ref when triggering a workflow. Cancel the prompt if no actual Actions run is wanted. Add/remove a workspace folder and close/reopen a Git repository to verify refresh behavior.

## Logs (0.32.5)

Click a job or a step in the Actions tree to view its output. Completed jobs open a read-only editor in VS Code, including command output, Docker messages and errors. Step logs open a separate document using GitHub's step-log endpoint. If an older server does not support that endpoint, the editor explicitly falls back to the complete job log. For jobs still running, the click opens the live GitHub page instead.

The editor title bar has **Refresh logs** for logs that are not available immediately. Existing folding, outline and ANSI formatting also apply. Log access uses your existing GitHub sign-in.

## Build a release

Open **Actions → Release VSIX → Run workflow** on `main`. The workflow reads the version from `package.json`, runs checks, builds the extension, and creates a `v<version>` GitHub Release containing the `.vsix` and its `.sha256` checksum. The same files are also retained as workflow artifacts.

Alternatively, push `v<version>` or `release-v<version>`; the tag must match `package.json`. Bump both package manifests before releasing a new version. A repeat run uploads/replaces the assets on the existing release. This workflow uses `GITHUB_TOKEN` and does not require a Marketplace publisher token.
