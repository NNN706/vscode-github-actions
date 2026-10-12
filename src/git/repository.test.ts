/* eslint-disable @typescript-eslint/require-await */
import {jest} from "@jest/globals";
import {URI, Utils} from "vscode-uri";
import type {Repository} from "../typings/git";

const repositories: Repository[] = [];
const folders: {uri: URI; name: string}[] = [];
const findFiles = jest.fn<() => Promise<URI[]>>();
const stat = jest.fn<() => Promise<unknown>>();
const openRepository = jest.fn<(uri: URI) => Promise<null>>().mockResolvedValue(null);
const getRepo = jest.fn<(args: {repo: string}) => Promise<unknown>>();
const dispatch = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const client = {repos: {get: getRepo}, actions: {createWorkflowDispatch: dispatch}};
const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
const showInputBox = jest.fn<() => Promise<string>>().mockResolvedValue("refs/heads/app-branch");
const git = {state: "initialized", repositories, openRepository};
jest.unstable_mockModule(
  "vscode",
  () => ({
    Uri: Object.assign(URI, {joinPath: (uri: URI, ...paths: string[]) => Utils.joinPath(uri, ...paths)}),
    commands: {
      registerCommand: (name: string, callback: (args: unknown) => Promise<unknown>) => {
        callbacks.set(name, callback);
        return {dispose: () => callbacks.delete(name)};
      },
      executeCommand: jest.fn()
    },
    workspace: {workspaceFolders: folders, isTrusted: true, findFiles, fs: {stat}},
    extensions: {getExtension: () => ({isActive: true, exports: {getAPI: () => git}})},
    window: {showWarningMessage: jest.fn(), showInputBox, setStatusBarMessage: jest.fn()}
  }),
  {virtual: true}
);
jest.unstable_mockModule("../external/ssh", () => ({
  resolve: (value: string) => {
    const match = /^git@([^:]+):(.+)$/.exec(value);
    return match ? {HostName: match[1], path: match[2]} : undefined;
  }
}));
jest.unstable_mockModule("../api/canReachGitHubAPI", () => ({canReachGitHubAPI: async () => true}));
jest.unstable_mockModule("../api/handleSamlError", () => ({
  handleSamlError: async (_: unknown, fn: (c: unknown) => unknown) => fn(client)
}));
jest.unstable_mockModule("../auth/auth", () => ({getSession: async () => ({account: {label: "tester"}})}));
jest.unstable_mockModule("../configuration/configuration", () => ({
  getRemoteName: () => "origin",
  useEnterprise: () => false,
  getGitHubApiUri: () => "https://api.github.com"
}));
jest.unstable_mockModule("../log", () => ({logDebug: jest.fn(), logError: jest.fn()}));
jest.unstable_mockModule("../workflow/workflow", () => ({
  getWorkflowUri: (repo: {workspaceUri: URI}, path: string) => Utils.joinPath(repo.workspaceUri, path),
  parseWorkflowFile: async () => ({events: {workflow_dispatch: {}}})
}));
let api: typeof import("./repository");
beforeAll(async () => {
  api = await import("./repository");
});
beforeEach(() => {
  repositories.length = 0;
  folders.length = 0;
  jest.clearAllMocks();
  findFiles.mockResolvedValue([]);
  stat.mockResolvedValue({type: 1});
  getRepo.mockImplementation(async () => ({
    data: {id: 1, default_branch: "main", owner: {type: "User"}, permissions: {push: true}}
  }));
  api.resetGitHubContext();
});
function repo(path: string, url: string, branch = "main") {
  return {
    rootUri: URI.file(path),
    status: async () => undefined,
    state: {remotes: [{name: "origin", fetchUrl: url}], HEAD: {type: 0, name: branch}}
  } as unknown as Repository;
}
test("discovers nested projects under a non-Git parent and deduplicates explicit roots", async () => {
  folders.push({uri: URI.file("/projects"), name: "."}, {uri: URI.file("/projects/infra"), name: "Ansible"});
  findFiles.mockResolvedValue([
    URI.file("/projects/infra/.github/workflows/ci.yml"),
    URI.file("/projects/app/.github/workflows/ci.yaml")
  ]);
  stat.mockImplementation(async (...args: unknown[]) => {
    if (String(args[0]) === "file:///projects/.git") throw new Error("not a repo");
    return {type: 1};
  });
  await api.discoverRepositories();
  expect(openRepository.mock.calls.map(([uri]) => uri.path)).toEqual(["/projects/infra", "/projects/app"]);
});
test("maps documents to deepest repo and does not match sibling prefixes or authorities", () => {
  const roots = ["/projects", "/projects/infra"].map(path => ({workspaceUri: URI.file(path)}));
  expect(api.findRepositoryForUri(roots, URI.file("/projects/infra/.github/workflows/ci.yml"))).toBe(roots[1]);
  expect(api.findRepositoryForUri(roots, URI.file("/projects/infra-other/file"))).toBe(roots[0]);
  expect(api.findRepositoryForUri(roots, URI.parse("vscode-remote://ssh/projects/infra/file"))).toBeUndefined();
});
test("supports SSH and fetch-only remotes while rejecting unrelated hosts", async () => {
  repositories.push(
    repo("/a", "git@github.com:owner/a.git"),
    repo("/b", "https://github.com/owner/b.git"),
    repo("/c", "git@gitlab.com:owner/c.git"),
    repo("/d", "https://github.com.evil.test/owner/d.git")
  );
  expect((await api.getGitHubUrls())?.map(info => info.protocol.repositoryName)).toEqual(["a", "b"]);
});
test("loads both projects and uses the selected repository branch", async () => {
  repositories.push(
    repo("/projects/infra", "git@github.com:owner/infra.git", "infra-branch"),
    repo("/projects/app", "git@github.com:owner/app.git", "app-branch")
  );
  const context = await api.getGitHubContext();
  expect(context?.repos).toHaveLength(2);
  const selected = await api.getGitHubContextForDocumentUri(URI.file("/projects/app/.github/workflows/ci.yml"));
  expect(selected?.name).toBe("app");
  if (!selected) throw new Error("Repository not resolved");
  expect(api.getGitHead(selected)).toBe("refs/heads/app-branch");
});
test("one inaccessible repository does not hide the other projects", async () => {
  repositories.push(repo("/a", "https://github.com/owner/a.git"), repo("/b", "https://github.com/owner/b.git"));
  getRepo.mockImplementation(async ({repo}) => {
    if (repo === "a") throw new Error("404");
    return {data: {id: 2, default_branch: "main", owner: {type: "User"}}};
  });
  expect((await api.getGitHubContext())?.repos.map(repo => repo.name)).toEqual(["b"]);
});
test("coalesces concurrent loads and refreshes after invalidation", async () => {
  repositories.push(repo("/a", "https://github.com/owner/a.git"));
  await Promise.all([api.getGitHubContext(), api.getGitHubContext()]);
  expect(getRepo).toHaveBeenCalledTimes(1);
  repositories.push(repo("/b", "https://github.com/owner/b.git"));
  api.resetGitHubContext();
  expect((await api.getGitHubContext())?.repos).toHaveLength(2);
});
test("includes every virtual GitHub workspace", async () => {
  folders.push(
    {uri: URI.parse("vscode-vfs://github/owner/a"), name: "a"},
    {uri: URI.parse("vscode-vfs://github/owner/b"), name: "b"}
  );
  expect((await api.getGitHubUrls())?.map(info => info.protocol.repositoryName)).toEqual(["a", "b"]);
});

test("dispatches a nested workflow to its repository with its own branch and relative path", async () => {
  repositories.push(
    repo("/projects/infra", "git@github.com:owner/infra.git", "infra-branch"),
    repo("/projects/app", "git@github.com:owner/app.git", "app-branch")
  );
  const {registerTriggerWorkflowRun} = await import("../commands/triggerWorkflowRun");
  registerTriggerWorkflowRun({subscriptions: []} as unknown as import("vscode").ExtensionContext);
  const command = callbacks.get("github-actions.explorer.triggerRun");
  if (!command) throw new Error("Command not registered");
  await command(URI.file("/projects/app/.github/workflows/ci.yml"));
  expect(showInputBox).toHaveBeenCalledWith({
    prompt: "Enter ref to trigger workflow on",
    value: "refs/heads/app-branch"
  });
  expect(dispatch).toHaveBeenCalledWith({
    owner: "owner",
    repo: "app",
    workflow_id: ".github/workflows/ci.yml",
    ref: "refs/heads/app-branch",
    inputs: undefined
  });
});
