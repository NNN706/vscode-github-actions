import * as vscode from "vscode";

import {GitHubRepoContext} from "../../git/repository";

export class CurrentBranchRepoNode extends vscode.TreeItem {
  constructor(public readonly gitHubRepoContext: GitHubRepoContext, public readonly currentBranchName: string) {
    super(`${gitHubRepoContext.owner}/${gitHubRepoContext.name}`, vscode.TreeItemCollapsibleState.Collapsed);

    this.description = currentBranchName;
    this.id = gitHubRepoContext.workspaceUri.toString();
    this.tooltip = gitHubRepoContext.workspaceUri.fsPath;
    this.contextValue = "cb-repo";
  }
}
