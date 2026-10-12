import {OctokitResponse} from "@octokit/types";
import * as vscode from "vscode";
import {getGitHubContextForRepo} from "../git/repository";
import {cacheLogInfo} from "./logInfo";
import {parseLog} from "./model";
import {parseUri} from "./scheme";

export class WorkflowStepLogProvider implements vscode.TextDocumentContentProvider {
  onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.onDidChangeEmitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const {owner, repo, jobId, stepIndex} = parseUri(uri);

    const githubRepoContext = await getGitHubContextForRepo(owner, repo);
    if (!githubRepoContext) {
      throw new Error("Could not load logs");
    }

    try {
      let log: string;
      try {
        const result =
          stepIndex === undefined
            ? await githubRepoContext.client.actions.downloadJobLogsForWorkflowRun({owner, repo, job_id: jobId})
            : await githubRepoContext.client.request(
                "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/steps/{step_number}/logs",
                {
                  owner,
                  repo,
                  job_id: jobId,
                  step_number: stepIndex,
                  headers: {"X-GitHub-Api-Version": "2026-03-10"}
                }
              );
        log = result.data as unknown as string;
      } catch (error) {
        // Older GitHub Enterprise servers may not support the step endpoint.
        if (stepIndex === undefined || (error as {status?: number}).status !== 404) throw error;
        const result = await githubRepoContext.client.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: jobId
        });
        log = "Individual step logs are unavailable. Showing the complete job log.\n\n" + String(result.data);
      }

      const logInfo = parseLog(log);
      cacheLogInfo(uri, logInfo);

      return logInfo.updatedLogLines.join("\n");
    } catch (e) {
      const respErr = e as OctokitResponse<unknown, number>;
      if (respErr.status === 410) {
        cacheLogInfo(uri, {
          sections: [],
          updatedLogLines: [],
          styleFormats: []
        });

        return "Could not open logs, they are expired.";
      }

      console.error("Error loading logs", e);
      cacheLogInfo(uri, {sections: [], updatedLogLines: [], styleFormats: []});
      if (respErr.status === 404)
        return "Logs are not available yet or have been removed. Use Refresh logs after GitHub finishes processing the job.";
      if (respErr.status === 403) return "Access to these logs was denied. Check your GitHub repository permissions.";
      return `Could not open logs: ${(e as Error).message}`;
    }
  }
}
