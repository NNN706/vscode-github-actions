import {jest} from "@jest/globals";
import {URI} from "vscode-uri";

const download = jest.fn<() => Promise<{data: string}>>();
const request = jest.fn<() => Promise<{data: string}>>();
const openTextDocument = jest.fn<() => Promise<unknown>>();
const showTextDocument = jest.fn<() => Promise<unknown>>();
const openExternal = jest.fn<() => Promise<boolean>>();
const context = {client: {actions: {downloadJobLogsForWorkflowRun: download}, request}};
jest.unstable_mockModule("vscode", () => ({
  Uri: URI,
  workspace: {openTextDocument},
  window: {showTextDocument},
  env: {openExternal},
  EventEmitter: class {
    event = jest.fn();
  }
}));
jest.unstable_mockModule("../git/repository", () => ({getGitHubContextForRepo: () => Promise.resolve(context)}));
jest.unstable_mockModule("./formatProvider", () => ({updateDecorations: jest.fn()}));
let Provider: typeof import("./fileProvider").WorkflowStepLogProvider;
let scheme: typeof import("./scheme");
let getLogInfo: typeof import("./logInfo").getLogInfo;
beforeAll(async () => {
  ({WorkflowStepLogProvider: Provider} = await import("./fileProvider"));
  scheme = await import("./scheme");
  ({getLogInfo} = await import("./logInfo"));
});
beforeEach(() => {
  jest.resetAllMocks();
});
const dockerLog = `2026-10-12T10:00:00.0000000Z ##[group]Run docker compose up -d --force-recreate
 Container loki Creating
 Container grafana Recreate
Error response from daemon: Conflict. The container name "/loki" is already in use.
Error: Process completed with exit code 1.`;
test("opens job output without losing Docker errors", async () => {
  download.mockResolvedValue({data: dockerLog});
  const uri = scheme.buildLogURI("#123 - deploy / prod? #1", "owner", "infra", 42);
  const text = await new Provider().provideTextDocumentContent(uri);
  expect(text).toContain('The container name "/loki" is already in use.');
  expect(text).toContain("Process completed with exit code 1.");
  expect(download).toHaveBeenCalledWith({owner: "owner", repo: "infra", job_id: 42});
  expect(scheme.parseUri(URI.parse(uri.toString()))).toEqual({
    owner: "owner",
    repo: "infra",
    jobId: 42,
    stepIndex: undefined
  });
  expect(getLogInfo(uri)?.sections.every(section => section.start >= 0 && section.end >= section.start)).toBe(true);
});
test("fetches the chosen step, including zero, and uses a distinct document URI", async () => {
  request.mockResolvedValue({data: dockerLog});
  const uri = scheme.buildLogURI("step", "owner", "second-repo", 84, 0);
  expect(scheme.parseUri(uri).stepIndex).toBe(0);
  expect(uri.toString()).not.toBe(scheme.buildLogURI("step", "owner", "second-repo", 84).toString());
  expect(await new Provider().provideTextDocumentContent(uri)).toContain("Container grafana Recreate");
  expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/steps/{step_number}/logs", {
    owner: "owner",
    repo: "second-repo",
    job_id: 84,
    step_number: 0,
    headers: {"X-GitHub-Api-Version": "2026-03-10"}
  });
  expect(download).not.toHaveBeenCalled();
});
test("falls back to the full job on servers without step log support", async () => {
  request.mockRejectedValue({status: 404});
  download.mockResolvedValue({data: dockerLog});
  const text = await new Provider().provideTextDocumentContent(scheme.buildLogURI("step", "owner", "infra", 42, 2));
  expect(text).toContain("Showing the complete job log");
  expect(text).toContain("Process completed with exit code 1.");
});
test("expired logs replace old formatting metadata", async () => {
  const uri = scheme.buildLogURI("job", "owner", "infra", 42);
  download.mockResolvedValueOnce({data: dockerLog}).mockRejectedValueOnce({status: 410});
  const provider = new Provider();
  await provider.provideTextDocumentContent(uri);
  expect(await provider.provideTextDocumentContent(uri)).toContain("expired");
  expect(getLogInfo(uri)?.sections).toEqual([]);
});

test("completed step logs open in the editor, not a browser", async () => {
  const {openWorkflowJobLogs} = await import("../commands/openWorkflowJobLogs");
  await openWorkflowJobLogs(
    {
      gitHubRepoContext: {owner: "owner", name: "infra"},
      job: {job: {id: 42, run_id: 123, name: "deploy", status: "completed"}}
    } as unknown as import("../commands/openWorkflowJobLogs").OpenWorkflowJobLogsCommandArgs,
    {index: 3, name: "docker compose"}
  );
  const calls = openTextDocument.mock.calls as unknown as [URI][];
  expect(scheme.parseUri(calls[0][0])).toEqual({owner: "owner", repo: "infra", jobId: 42, stepIndex: 3});
  expect(showTextDocument).toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});
test("running jobs open their live GitHub page without trying to download logs", async () => {
  const {openWorkflowJobLogs} = await import("../commands/openWorkflowJobLogs");
  await openWorkflowJobLogs(
    {
      gitHubRepoContext: {owner: "owner", name: "infra"},
      job: {job: {status: "in_progress", html_url: "https://github.com/owner/infra/actions/runs/123/job/42"}}
    } as unknown as import("../commands/openWorkflowJobLogs").OpenWorkflowJobLogsCommandArgs,
    {index: 3, name: "docker compose"}
  );
  const calls = openExternal.mock.calls as unknown as [URI][];
  expect(calls[0][0].fragment).toBe("step:4:1");
  expect(openTextDocument).not.toHaveBeenCalled();
});
