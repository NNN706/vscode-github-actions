import {jest} from "@jest/globals";
import type {Repository} from "../typings/git";
import type {ExtensionContext} from "vscode";

function event<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return {
    subscribe: (listener: (value: T) => unknown) => {
      listeners.add(listener);
      return {dispose: () => listeners.delete(listener)};
    },
    fire: (value: T) => listeners.forEach(listener => listener(value)),
    listeners
  };
}
const opened = event<Repository>();
const closed = event<Repository>();
const state = event<void>();
const folders = event<void>();
const created = event<void>();
const deleted = event<void>();
const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const discover = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const reset = jest.fn();
const head = {name: "main"};
const repo = {state: {HEAD: head, remotes: [], onDidChange: state.subscribe}} as unknown as Repository;
jest.unstable_mockModule("vscode", () => ({
  commands: {executeCommand: execute},
  workspace: {
    onDidChangeWorkspaceFolders: folders.subscribe,
    createFileSystemWatcher: () => ({
      onDidCreate: created.subscribe,
      onDidDelete: deleted.subscribe,
      dispose: jest.fn()
    })
  }
}));
jest.unstable_mockModule("../git/repository", () => ({
  discoverRepositories: discover,
  resetGitHubContext: reset,
  getGitExtension: () =>
    Promise.resolve({
      repositories: [repo],
      onDidOpenRepository: opened.subscribe,
      onDidCloseRepository: closed.subscribe
    })
}));
jest.unstable_mockModule("../log", () => ({logError: jest.fn()}));

test("tracks newly opened repositories, branch changes and close without rediscovery; disposes listeners", async () => {
  jest.useFakeTimers();
  const {initWorkspaceChangeTracker} = await import("./workspaceTracker");
  const context = {subscriptions: []} as unknown as ExtensionContext;
  try {
    await initWorkspaceChangeTracker(context);
    expect(discover).toHaveBeenCalledTimes(1);
    execute.mockClear();
    state.fire();
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    head.name = "feature";
    state.fire();
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    expect(reset).toHaveBeenCalled();
    expect(execute).toHaveBeenLastCalledWith("github-actions.explorer.refresh", false);
    closed.fire(repo);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    expect(state.listeners.size).toBe(0);
    expect(discover).toHaveBeenCalledTimes(1);
    opened.fire(repo);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    expect(state.listeners.size).toBe(1);
    expect(discover).toHaveBeenCalledTimes(1);
    folders.fire();
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {
    context.subscriptions.forEach(subscription => {
      subscription.dispose();
    });
    expect(state.listeners.size).toBe(0);
    expect(opened.listeners.size).toBe(0);
    jest.useRealTimers();
  }
});
