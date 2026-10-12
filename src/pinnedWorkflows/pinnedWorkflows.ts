import * as vscode from "vscode";

import {
  getPinnedWorkflows,
  isPinnedWorkflowsRefreshEnabled,
  onPinnedWorkflowsChange,
  pinnedWorkflowsRefreshInterval
} from "../configuration/configuration";
import {getGitHubContextForDocumentUri, GitHubRepoContext} from "../git/repository";

import {log, logError} from "../log";
import {Workflow} from "../model";
import {RunStore} from "../store/store";
import {WorkflowRun} from "../store/workflowRun";
import {getCodIconForWorkflowRun} from "../treeViews/icons";
import {WorkflowRunCommandArgs} from "../treeViews/shared/workflowRunNode";

interface PinnedWorkflow {
  /** Displayed name */
  workflowName: string;

  workflowId: number;

  lastRunId: number | undefined;

  gitHubRepoContext: GitHubRepoContext;

  /** Status bar item created for this workflow */
  statusBarItem: vscode.StatusBarItem;
}

const pinnedWorkflows: PinnedWorkflow[] = [];
let refreshTimer: NodeJS.Timeout | undefined;
let runStore: RunStore;

export async function initPinnedWorkflows(store: RunStore) {
  // Register handler for configuration changes
  onPinnedWorkflowsChange(() => void _init());

  runStore = store;
  runStore.event(({run}) => {
    // Are we listening to this run?
    const workflowId = run.run.workflow_id;
    for (const pinnedWorkflow of pinnedWorkflows) {
      if (pinnedWorkflow.workflowId === workflowId && pinnedWorkflow.lastRunId === run.run.id) {
        updatePinnedWorkflow(pinnedWorkflow, run);
        break;
      }
    }
  });

  await _init();
}

async function _init(): Promise<void> {
  await updatePinnedWorkflows();

  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  if (isPinnedWorkflowsRefreshEnabled()) {
    refreshTimer = setInterval(() => void refreshPinnedWorkflows(), pinnedWorkflowsRefreshInterval() * 1000);
  }
}

export async function updatePinnedWorkflows() {
  clearPinnedWorkflows();
  const pinnedWorkflows = getPinnedWorkflows();

  // Assume we have a folder open. Without a folder open, we can't do anything
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const workflowsByRepository = new Map<GitHubRepoContext, string[]>();
  for (const pinnedWorkflow of pinnedWorkflows) {
    const segments = pinnedWorkflow.split(/[\\/]/);
    const namedWorkspace = vscode.workspace.workspaceFolders.find(folder => folder.name === segments[0]);
    const workspace = namedWorkspace || vscode.workspace.workspaceFolders[0];
    const path = namedWorkspace ? segments.slice(1).join("/") : segments.join("/");
    const uri = vscode.Uri.joinPath(workspace.uri, path);
    const repo = await getGitHubContextForDocumentUri(uri);
    if (!repo) continue;
    const relativePath = uri.path.slice(repo.workspaceUri.path.replace(/\/$/, "").length + 1);
    workflowsByRepository.set(repo, [...(workflowsByRepository.get(repo) || []), relativePath]);
  }

  for (const [gitHubRepoContext, paths] of workflowsByRepository) {
    // Get all workflows to resolve names. We could do this locally, but for now, let's make the API call.
    const workflows = await gitHubRepoContext.client.paginate(
      gitHubRepoContext.client.actions.listRepoWorkflows,
      {
        owner: gitHubRepoContext.owner,
        repo: gitHubRepoContext.name,
        per_page: 100
      },
      response => response.data
    );

    const workflowByPath: {[id: string]: Workflow} = {};
    workflows.forEach(w => (workflowByPath[w.path] = w));

    for (const pinnedWorkflow of paths) {
      if (!workflowByPath[pinnedWorkflow]) {
        log(
          `Unable to find pinned workflow ${pinnedWorkflow} in ${gitHubRepoContext.owner}/${gitHubRepoContext.name}, ignoring`
        );
        continue;
      }

      const pW = createPinnedWorkflow(gitHubRepoContext, workflowByPath[pinnedWorkflow]);
      await refreshPinnedWorkflow(pW);
    }
  }
}

async function refreshPinnedWorkflows() {
  for (const pinnedWorkflow of pinnedWorkflows) {
    await refreshPinnedWorkflow(pinnedWorkflow);
  }
}

function clearPinnedWorkflows() {
  // Remove any existing pinned workflows
  for (const pinnedWorkflow of pinnedWorkflows) {
    pinnedWorkflow.statusBarItem.hide();
    pinnedWorkflow.statusBarItem.dispose();
  }

  pinnedWorkflows.splice(0, pinnedWorkflows.length);
}

function createPinnedWorkflow(gitHubRepoContext: GitHubRepoContext, workflow: Workflow): PinnedWorkflow {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

  const pinnedWorkflow = {
    gitHubRepoContext,
    workflowId: workflow.id,
    workflowName: workflow.name,
    lastRunId: undefined,
    statusBarItem
  };

  pinnedWorkflows.push(pinnedWorkflow);

  return pinnedWorkflow;
}

async function refreshPinnedWorkflow(pinnedWorkflow: PinnedWorkflow) {
  const {gitHubRepoContext} = pinnedWorkflow;

  try {
    const runs = await gitHubRepoContext.client.actions.listWorkflowRuns({
      owner: gitHubRepoContext.owner,
      repo: gitHubRepoContext.name,
      workflow_id: pinnedWorkflow.workflowId, // Workflow can also be a file name
      per_page: 1
    });
    const {workflow_runs} = runs.data;

    // Add all runs to store
    for (const run of workflow_runs) {
      runStore.addRun(gitHubRepoContext, run);
    }

    const mostRecentRun = workflow_runs?.[0];

    updatePinnedWorkflow(pinnedWorkflow, mostRecentRun && runStore.getRun(mostRecentRun.id));
  } catch (e) {
    logError(e as Error, "Error updating pinned workflow");
  }
}

function updatePinnedWorkflow(pinnedWorkflow: PinnedWorkflow, run: WorkflowRun | undefined) {
  if (!run) {
    // Workflow has never run, set default text
    pinnedWorkflow.statusBarItem.text = `$(${getCodIconForWorkflowRun()}) ${pinnedWorkflow.workflowName}`;

    // Can't do anything without a run
    pinnedWorkflow.statusBarItem.command = undefined;
  } else {
    pinnedWorkflow.statusBarItem.text = `$(${getCodIconForWorkflowRun(run.run)}) ${pinnedWorkflow.workflowName}`;

    if (run.run.conclusion === "failure") {
      pinnedWorkflow.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else {
      pinnedWorkflow.statusBarItem.backgroundColor = undefined;
    }

    pinnedWorkflow.statusBarItem.command = {
      title: "Open workflow run",
      command: "github-actions.workflow.run.open",
      arguments: [
        {
          run: run,
          store: runStore,
          gitHubRepoContext: pinnedWorkflow.gitHubRepoContext
        } satisfies WorkflowRunCommandArgs
      ]
    };
  }

  pinnedWorkflow.lastRunId = run?.run.id;

  // Ensure the status bar item is visible
  pinnedWorkflow.statusBarItem.show();
}
