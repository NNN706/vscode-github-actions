import * as vscode from "vscode";
import {LogScheme} from "./constants";

/**
 * @param displayName Must not contain '/'
 */
export function buildLogURI(
  displayName: string,
  owner: string,
  repo: string,
  jobId: number,
  stepIndex?: number
): vscode.Uri {
  const query = `${jobId}${stepIndex === undefined ? "" : `&step=${stepIndex}`}`;
  return vscode.Uri.from({
    scheme: LogScheme,
    authority: owner,
    path: `/${repo}/${displayName.replace(/\//g, " ∕ ")}`,
    query
  });
}

export function parseUri(uri: vscode.Uri): {
  owner: string;
  repo: string;
  jobId: number;
  stepIndex?: number;
} {
  if (uri.scheme != LogScheme) {
    throw new Error("Uri is not of log scheme");
  }

  return {
    owner: uri.authority,
    repo: uri.path.split("/").slice(0, 2).join(""),
    jobId: parseInt(uri.query, 10),
    stepIndex: /(?:^|&)step=(\d+)(?:&|$)/.test(uri.query)
      ? Number(new URLSearchParams(uri.query).get("step"))
      : undefined
  };
}
