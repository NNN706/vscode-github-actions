# Visual Studio Marketplace publishing

The **Release VSIX and publish to Marketplace** workflow builds and tests the extension, attaches a VSIX and SHA-256 file to GitHub Releases, then publishes the **same artifact** to Visual Studio Marketplace. It never rebuilds the extension in the publishing job.

## One-time account setup

1. Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage) and create or select your publisher. The publisher ID must exactly match `publisher` in `package.json` (currently `NN703`). A GitHub username does not automatically create a Marketplace publisher. If the actual ID differs, update the manifest and README Marketplace link before building the first Marketplace release.
2. Create an Azure DevOps personal access token according to the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token): choose **All accessible organizations**, **Marketplace → Manage**, and an expiration date. The Microsoft account must have publishing access to your publisher.
3. In [repository Actions secrets](https://github.com/NNN706/vscode-github-actions/settings/secrets/actions), add a secret named **VSCE_PAT**. Alternatively, store it as an environment secret in the `marketplace` environment. Do not commit or paste the token into chat.
4. Open [the publishing workflow](https://github.com/NNN706/vscode-github-actions/actions/workflows/publish.yml), select **Run workflow**, branch `main`, and leave **publish_marketplace** checked.

The workflow fails with a specific setup error if the credential is missing; the GitHub Release job remains independent. No Marketplace publisher has been created by this repository.

## Subsequent versions

- Update both package manifests with `npm version patch --no-git-tag-version` (or choose minor/major), commit, and push to `main`.
- Push a matching `v<version>` tag. `release-v<version>` is also supported. Tag pushes automatically build, release, and publish.
- Alternatively run the workflow manually on `main`. Uncheck **publish_marketplace** for a GitHub Release only.
- Already-published Marketplace versions are skipped using `--skip-duplicate`; a changed extension requires a new version number.
- After adding or fixing credentials, use **Re-run failed jobs** so that the Marketplace job reuses the successful build artifact.

The expected extension ID is `NN703.vscode-github-actions-multi-repo`. Publication can take time to become visible while Marketplace validates the package. The fork must run with the official `GitHub.vscode-github-actions` extension disabled because they share command and view IDs.

## Authentication lifecycle

As of October 2026, the linked Microsoft guide states that global Azure DevOps PATs retire on **December 1, 2026** and recommends Microsoft Entra ID with workload identity federation. The PAT workflow is supported for initial setup now, but must be migrated before that deadline. Entra-based publishing requires a tenant/application or managed identity, a GitHub federated identity credential, publisher membership, and a newer `vsce` supporting `--azure-credential`; these account resources cannot be inferred from the GitHub login.

## Switching from the initial local fork

The initial VSIX used publisher `NNN706`. Packages built after the publisher correction use `NN703`, which is a different extension identity. Disable or uninstall `NNN706.vscode-github-actions-multi-repo` before enabling `NN703.vscode-github-actions-multi-repo`; their commands and view IDs overlap. The GitHub repository remains under `NNN706`.
