import * as vscode from "vscode";

import {canReachGitHubAPI} from "../api/canReachGitHubAPI";
import {executeCacheClearCommand} from "../workflow/languageServer";
import {getGitHubContext, resetGitHubContext, discoverRepositories} from "../git/repository";
import {updatePinnedWorkflows} from "../pinnedWorkflows/pinnedWorkflows";
import {RunStore} from "../store/store";
import {CurrentBranchTreeProvider} from "./currentBranch";
import {SettingsTreeProvider} from "./settings";
import {WorkflowsTreeProvider} from "./workflows";

export function initTreeViews(context: vscode.ExtensionContext, store: RunStore): void {
  const workflowTreeProvider = new WorkflowsTreeProvider(store);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("github-actions.workflows", workflowTreeProvider));

  const settingsTreeProvider = new SettingsTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("github-actions.settings", settingsTreeProvider));

  const currentBranchTreeProvider = new CurrentBranchTreeProvider(store);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("github-actions.current-branch", currentBranchTreeProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("github-actions.explorer.refresh", async (discover = true) => {
      if (discover) await discoverRepositories();
      resetGitHubContext();
      const canReachAPI = await canReachGitHubAPI();
      await vscode.commands.executeCommand("setContext", "github-actions.internet-access", canReachAPI);

      const ghContext = await getGitHubContext();
      const hasGitHubRepos = ghContext && ghContext.repos.length > 0;
      await vscode.commands.executeCommand("setContext", "github-actions.has-repos", hasGitHubRepos);

      if (canReachAPI) {
        await workflowTreeProvider.refresh();
        await settingsTreeProvider.refresh();
        await currentBranchTreeProvider.refresh();
      }
      await updatePinnedWorkflows();
      await executeCacheClearCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("github-actions.explorer.current-branch.refresh", async () => {
      await currentBranchTreeProvider.refresh();
    })
  );
}
