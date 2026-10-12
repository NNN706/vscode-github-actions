import * as vscode from "vscode";
import {Octokit} from "@octokit/rest";

import {canReachGitHubAPI} from "../api/canReachGitHubAPI";
import {handleSamlError} from "../api/handleSamlError";
import {getSession} from "../auth/auth";
import {getGitHubApiUri, getRemoteName, useEnterprise} from "../configuration/configuration";
import {Protocol} from "../external/protocol";
import {logDebug, logError} from "../log";
import {API, GitExtension, RefType, RepositoryState} from "../typings/git";
import {RepositoryPermission, getRepositoryPermission} from "./repository-permissions";

interface GitHubUrls {
  workspaceUri: vscode.Uri;
  url: string;
  protocol: Protocol;
}

export async function getGitExtension(): Promise<API | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (gitExtension) {
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
    const git = gitExtension.exports.getAPI(1);

    if (git.state !== "initialized") {
      // Wait for the plugin to be initialized
      await new Promise<void>(resolve => {
        if (git.state === "initialized") {
          resolve();
        } else {
          const listener = git.onDidChangeState(state => {
            if (state === "initialized") {
              resolve();
            }
            listener.dispose();
          });
        }
      });
    }

    return git;
  }
}

/** Resolve a document against the deepest repository root, not its workspace folder. */
export function findRepositoryForUri<T extends {workspaceUri: vscode.Uri}>(repos: T[], uri: vscode.Uri): T | undefined {
  return repos
    .filter(({workspaceUri: root}) => {
      const path = root.path.replace(/\/$/, "");
      return (
        root.scheme === uri.scheme &&
        root.authority === uri.authority &&
        (uri.path === path || uri.path.startsWith(`${path}/`))
      );
    })
    .sort((a, b) => b.workspaceUri.path.length - a.workspaceUri.path.length)[0];
}

export function getGitHead(repo: GitHubRepoContext): string | undefined {
  const branch = getCurrentBranch(repo.repositoryState);
  return branch ? `refs/heads/${branch}` : undefined;
}

/** Open explicit workspace roots and nested repositories containing workflows. */
export async function discoverRepositories(): Promise<void> {
  const git = await getGitExtension();
  if (!git || !vscode.workspace.isTrusted) return;

  const roots = new Map<string, vscode.Uri>();
  for (const folder of vscode.workspace.workspaceFolders || []) {
    roots.set(folder.uri.toString(), folder.uri);
  }
  const workflows = await vscode.workspace.findFiles(
    "**/.github/workflows/*.{yml,yaml}",
    "**/{node_modules,.git,.venv,vendor,dist,build}/**"
  );
  for (const workflow of workflows) {
    const root = vscode.Uri.joinPath(workflow, "../../..");
    roots.set(root.toString(), root);
  }
  for (const root of roots.values()) {
    if (git.repositories.some(repo => repo.rootUri.toString() === root.toString())) continue;
    try {
      // Accept both .git directories and worktree/submodule .git files.
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ".git"));
      await git.openRepository(root);
    } catch {
      // A workspace folder or workflow directory need not be a Git repository.
    }
  }
}

export async function getGitHubUrls(): Promise<GitHubUrls[] | null> {
  const git = await getGitExtension();
  const urls = new Map<string, GitHubUrls>();
  const remoteName = getRemoteName();
  for (const repo of git?.repositories || []) {
    try {
      await repo.status();
      const remote = repo.state.remotes.find(remote => remote.name === remoteName) || repo.state.remotes[0];
      const url = remote?.pushUrl || remote?.fetchUrl;
      if (!url) continue;
      const protocol = new Protocol(url);
      const host = protocol.host.toLowerCase();
      const enterpriseHost = new URL(getGitHubApiUri()).hostname.replace(/^api\./, "");
      if (
        !protocol.owner ||
        !protocol.repositoryName ||
        (host !== "github.com" && !(useEnterprise() && host === enterpriseHost))
      )
        continue;
      urls.set(repo.rootUri.toString(), {workspaceUri: repo.rootUri, url, protocol});
    } catch (error) {
      logError(error as Error, `Could not read repository ${repo.rootUri.toString()}`);
    }
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== "vscode-vfs" || folder.uri.authority !== "github") continue;
    const url = `https://github.com${folder.uri.path}`;
    urls.set(folder.uri.toString(), {workspaceUri: folder.uri, url, protocol: new Protocol(url)});
  }
  return [...urls.values()];
}

export interface GitHubRepoContext {
  client: Octokit;
  repositoryState: RepositoryState | undefined;

  workspaceUri: vscode.Uri;

  id: number;
  owner: string;
  name: string;

  organizationOwned: boolean;
  defaultBranch: string;
  permissionLevel: RepositoryPermission;
}

export interface GitHubContext {
  repos: GitHubRepoContext[];
  reposByUri: Map<string, GitHubRepoContext>;
  reposByOwnerAndName: Map<string, GitHubRepoContext>;
  username: string;
}

let gitHubContext: Promise<GitHubContext | undefined> | undefined;

export async function getGitHubContext(): Promise<GitHubContext | undefined> {
  if (gitHubContext) {
    return gitHubContext;
  }

  const pending = loadGitHubContext();
  gitHubContext = pending;
  try {
    const result = await pending;
    if (!result && gitHubContext === pending) gitHubContext = undefined;
    return result;
  } catch (error) {
    if (gitHubContext === pending) gitHubContext = undefined;
    throw error;
  }
}

async function loadGitHubContext(): Promise<GitHubContext | undefined> {
  if (!(await canReachGitHubAPI())) {
    logError(new Error("Cannot fetch github context"));
    return undefined;
  }

  try {
    const git = await getGitExtension();

    const allProtocolInfos = await getGitHubUrls();

    // Filter out wiki repositories because the GET call will fail and throw an error
    const protocolInfos = allProtocolInfos?.filter(info => !info.protocol.repositoryName.match(/\.wiki$/));

    if (!protocolInfos) {
      logDebug("Could not get protocol infos");
      return undefined;
    }

    logDebug("Found protocol infos", protocolInfos.length.toString());

    const session = await getSession();
    if (!session) {
      // User is not signed in, getSession will prompt them to sign in
      return undefined;
    }
    const username = session.account.label;

    const results = await Promise.all(
      protocolInfos.map(async protocolInfo => {
        try {
          return await handleSamlError(session, async (client: Octokit): Promise<GitHubRepoContext> => {
            const repoInfo = await client.repos.get({
              repo: protocolInfo.protocol.repositoryName,
              owner: protocolInfo.protocol.owner
            });
            const repo = git?.repositories.find(
              repo => repo.rootUri.toString() === protocolInfo.workspaceUri.toString()
            );
            return {
              workspaceUri: protocolInfo.workspaceUri,
              client,
              repositoryState: repo?.state,
              name: protocolInfo.protocol.repositoryName,
              owner: protocolInfo.protocol.owner,
              id: repoInfo.data.id,
              defaultBranch: `refs/heads/${repoInfo.data.default_branch}`,
              organizationOwned: repoInfo.data.owner.type === "Organization",
              permissionLevel: getRepositoryPermission(repoInfo.data.permissions)
            };
          });
        } catch (error) {
          logError(
            error as Error,
            `Could not load ${protocolInfo.protocol.nameWithOwner}; other repositories remain available`
          );
          return undefined;
        }
      })
    );
    const repos = results.filter((repo): repo is GitHubRepoContext => repo !== undefined);

    return {
      repos,
      reposByUri: new Map(repos.map(r => [r.workspaceUri.toString(), r])),
      reposByOwnerAndName: new Map(repos.map(r => [`${r.owner}/${r.name}`.toLocaleLowerCase(), r])),
      username
    };
  } catch (e) {
    logError(e as Error, "Error getting GitHub context");

    // Rethrow original error
    throw e;
  }
}

export function resetGitHubContext() {
  gitHubContext = undefined;
}

export async function getGitHubContextForRepo(owner: string, name: string): Promise<GitHubRepoContext | undefined> {
  const gitHubContext = await getGitHubContext();
  if (!gitHubContext) {
    return undefined;
  }

  const searchKey = `${owner}/${name}`.toLocaleLowerCase();
  return gitHubContext.reposByOwnerAndName.get(searchKey);
}

export async function getGitHubContextForWorkspaceUri(
  workspaceUri: vscode.Uri
): Promise<GitHubRepoContext | undefined> {
  const gitHubContext = await getGitHubContext();
  if (!gitHubContext) {
    return undefined;
  }

  return gitHubContext.reposByUri.get(workspaceUri.toString());
}

export async function getGitHubContextForDocumentUri(documentUri: vscode.Uri): Promise<GitHubRepoContext | undefined> {
  const gitHubContext = await getGitHubContext();
  if (!gitHubContext) {
    return undefined;
  }

  return findRepositoryForUri(gitHubContext.repos, documentUri);
}

export function getCurrentBranch(state: RepositoryState | undefined): string | undefined {
  if (!state) {
    return;
  }

  const head = state.HEAD;
  if (!head) {
    return;
  }

  if (head.type != RefType.Head) {
    return;
  }

  return head.name;
}
