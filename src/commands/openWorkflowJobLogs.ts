import * as vscode from "vscode";
import {GitHubRepoContext} from "../git/repository";
import {updateDecorations} from "../logs/formatProvider";
import {getLogInfo} from "../logs/logInfo";
import {buildLogURI} from "../logs/scheme";
import {WorkflowJob} from "../store/WorkflowJob";

export interface OpenWorkflowJobLogsCommandArgs {
  gitHubRepoContext: GitHubRepoContext;
  job: WorkflowJob;
}

export async function openWorkflowJobLogs(args: OpenWorkflowJobLogsCommandArgs, step?: {index: number; name: string}) {
  const {gitHubRepoContext, job} = args;
  if (job.job.status !== "completed") {
    if (job.job.html_url) {
      const url = vscode.Uri.parse(job.job.html_url);
      await vscode.env.openExternal(step ? url.with({fragment: `step:${step.index + 1}:1`}) : url);
    }
    return;
  }
  const uri = buildLogURI(
    `#${job.job.run_id} - ${job.job.name}${step ? ` - ${step.name}` : ""}`,
    gitHubRepoContext.owner,
    gitHubRepoContext.name,
    job.job.id,
    step?.index
  );
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {preview: false});
  const logInfo = getLogInfo(uri);
  if (logInfo) updateDecorations(editor, logInfo);
}

export function registerOpenWorkflowJobLogs(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand("github-actions.workflow.logs", openWorkflowJobLogs));
}
