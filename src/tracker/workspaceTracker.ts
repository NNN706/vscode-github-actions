import * as vscode from "vscode";

import {discoverRepositories, getGitExtension, resetGitHubContext} from "../git/repository";
import {logError} from "../log";
import {Repository} from "../typings/git";

export async function initWorkspaceChangeTracker(context: vscode.ExtensionContext) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let refreshing = false;
  let pending = false;
  const refresh = async () => {
    if (refreshing || disposed) return;
    refreshing = true;
    pending = false;
    try {
      await vscode.commands.executeCommand("github-actions.explorer.refresh", false);
    } catch (error) {
      logError(error as Error, "Could not refresh repositories");
    } finally {
      refreshing = false;
      if (pending && !disposed) scheduleRefresh();
    }
  };
  const scheduleRefresh = () => {
    resetGitHubContext();
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 200);
  };
  const discover = async () => {
    try {
      await discoverRepositories();
      scheduleRefresh();
    } catch (error) {
      logError(error as Error, "Could not discover repositories");
    }
  };
  const listeners = new Map<Repository, vscode.Disposable>();
  const watch = (repo: Repository) => {
    if (listeners.has(repo)) return;
    const snapshot = () => JSON.stringify({head: repo.state.HEAD, remotes: repo.state.remotes});
    let previous = snapshot();
    listeners.set(
      repo,
      repo.state.onDidChange(() => {
        const current = snapshot();
        if (previous !== current) {
          previous = current;
          scheduleRefresh();
        }
      })
    );
  };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(discover), {
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const listener of listeners.values()) listener.dispose();
      listeners.clear();
    }
  });
  const git = await getGitExtension();
  if (git) {
    context.subscriptions.push(
      git.onDidOpenRepository(repo => {
        watch(repo);
        scheduleRefresh();
      }),
      git.onDidCloseRepository(repo => {
        listeners.get(repo)?.dispose();
        listeners.delete(repo);
        scheduleRefresh();
      })
    );
    git.repositories.forEach(watch);
  }
  // New nested projects may appear without a workspace-folder change.
  const watcher = vscode.workspace.createFileSystemWatcher("**/.github/workflows/*.{yml,yaml}");
  context.subscriptions.push(watcher, watcher.onDidCreate(discover), watcher.onDidDelete(scheduleRefresh));
  await discoverRepositories();
  await refresh();
}
