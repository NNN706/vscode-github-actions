import * as vscode from "vscode";
import {WorkflowStepNode} from "../treeViews/workflows/workflowStepNode";
import {openWorkflowJobLogs} from "./openWorkflowJobLogs";

type WorkflowStepCommandArgs = Pick<WorkflowStepNode, "job" | "step" | "gitHubRepoContext">;

export function registerOpenWorkflowStepLogs(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("github-actions.step.logs", async (args: WorkflowStepCommandArgs) => {
      const index = args.job.job.steps?.findIndex(step => step.number === args.step.number);
      if (index === undefined || index < 0) return;
      await openWorkflowJobLogs(args, {index, name: args.step.name});
    })
  );
}
