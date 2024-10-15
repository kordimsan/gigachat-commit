import * as vscode from "vscode";
import { GigaChat } from "gigachat-node";


export function activate(context: vscode.ExtensionContext) {
  let cancellationTokenSource: vscode.CancellationTokenSource | null = null;

  let disposable = vscode.commands.registerCommand(
    "gigachat-commit.suggest",
    async () => {
      if (cancellationTokenSource) {
        vscode.window
          .showInformationMessage("Thinking...", "Cancel")
          .then((selectedItem) => {
            if (selectedItem === "Cancel") {
              cancellationTokenSource?.cancel();
              cancellationTokenSource?.dispose();
              cancellationTokenSource = null;
            }
          });
        return;
      } else {
        cancellationTokenSource = new vscode.CancellationTokenSource();
      }

      await suggest(cancellationTokenSource.token);

      cancellationTokenSource.dispose();
      cancellationTokenSource = null;
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

const suggest = async (cancelToken: vscode.CancellationToken) => {
  try {
    const config = vscode.workspace.getConfiguration("gigachat-commit");

    const authKey: string | undefined = config.get("authKey");
    const prompt: string | undefined = config.get("prompt");
    const model: string | undefined = config.get("model");

    if (!authKey) {
      const action = "Go to Settings";

      vscode.window
        .showInformationMessage("Set your GigaChat API key first!", action)
        .then((selectedItem) => {
          if (selectedItem === action) {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "gigachat-commit.authKey"
            );
          }
        });
      return;
    }

    const gitExtension = vscode.extensions.getExtension("vscode.git");

    if (!gitExtension) {
      vscode.window.showErrorMessage("Failed to find the Git extension!");
      return;
    }

    const git = gitExtension.exports.getAPI(1);

    const currentRepo = git.repositories[0];

    if (!currentRepo) {
      vscode.window.showErrorMessage("Failed to find a Git repository!");
      return;
    }

    const stagedChangesDiff = await currentRepo.diffIndexWith("HEAD");

    if (stagedChangesDiff.length === 0) {
      vscode.window.showErrorMessage("There are no staged changes!");
      return;
    }

    let parsed = [],
      deleted = [],
      renamed = [];

    for (const change of stagedChangesDiff) {
      switch (change.status) {
        case 3:
          renamed.push(
            `RENAMED: ${change.originalUri.path} to ${change.renameUri.path};`
          );
          break;
        case 6:
          deleted.push(`DELETED: ${change.originalUri.path};`);
          break;
        default:
          const fileDiff = await currentRepo.diffIndexWithHEAD(
            change.uri.fsPath
          );
          parsed.push(fileDiff);
          break;
      }
    }

    if (!prompt || prompt.length < 10) {
      vscode.window.showErrorMessage("Prompt is too short!");
      return;
    }

    if (!model) {
      vscode.window.showErrorMessage("GigaChat model is not set!");
      return;
    }

    const client = new GigaChat(authKey);
    await client.createToken();
    client
      .completion({
        model,
        messages: [
          {
            role: "user",
            content: `"${prompt}"`
          },
          {
            role: "user",
            content: `${parsed.join("\n")}\n\n${deleted.join(
              "\n"
            )}\n\n${renamed.join("\n")}`
          }
        ]
      })
      .then(response => {
        currentRepo.inputBox.value = response.choices[0].message.content;
      });
  } catch (error: any) {
    vscode.window.showErrorMessage(error.toString());
  }
};
