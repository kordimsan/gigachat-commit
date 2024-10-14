import * as vscode from "vscode";
import { request } from "https";
import { TextDecoder } from "util";
import { v4 as uuidv4 } from "uuid";


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

// Функция для получения токена
const getAuthToken = async (authKey: string) => {
  return new Promise<string>((resolve, reject) => {
    const options = {
      method: "POST",
      hostname: "ngw.devices.sberbank.ru",
      port: 9443,
      path: "/api/v2/oauth",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: uuidv4(),
        Authorization: "Basic " + authKey
      }
    };

    const req = request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          const token = JSON.parse(data).access_token;
          resolve(token);
        } else {
          reject(`Failed to get token: ${res.statusCode} ${data}`);
        }
      });
    });

    req.on("error", (e) => {
      reject(`Failed to get token: ${e.message}`);
    });

    const qs = require("querystring");

    let postData = qs.stringify({
      scope: "GIGACHAT_API_PERS"
    });

    req.write(postData);
    req.end();
  });
};

// Функция для генерации текста с использованием GigaChat API
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

    const authToken = await getAuthToken(authKey);

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

    await sendChatCompletion({
      opts: {
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
        ],
        model,
        max_tokens: 256,
        stream: false,
        update_interval: 0
      },
      authToken,
      onText: (text) => (currentRepo.inputBox.value = text),
      cancelToken
    });
  } catch (error: any) {
    vscode.window.showErrorMessage(error.toString());
  }
};

type SendChatCompletion = (props: {
  opts: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    model: string;
    max_tokens: number;
    update_interval: number;
    stream: boolean;
  };
  authToken: string;
  onText: (text: string) => void;
  cancelToken: vscode.CancellationToken;
}) => Promise<void | string>;

// Функция для отправки запроса на /chat GigaChat API
const sendChatCompletion: SendChatCompletion = ({
  opts,
  authToken,
  onText,
  cancelToken
}) => {
  return new Promise((resolve, reject) => {
    const options = {
      method: "POST",
      hostname: "https://gigachat.devices.sberbank.ru",
      path: "/api/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`
      }
    };

    const req = request(options, (res) => {
      const decoder = new TextDecoder("utf8");

      if (res.statusCode !== 200) {
        res.on("data", (chunk) => {
          reject(
            `GigaChat: ${res.statusCode} - ${
              JSON.parse(decoder.decode(chunk) || "{}")?.error?.message ||
              "unknown"
            }`
          );
        });
        return;
      }

      let fullText = "";

      res.on("data", (chunk) => {
        const data = decoder.decode(chunk);
        const { content } = JSON.parse(data).choices[0].message;
        onText(content);
      });

      res.on("end", () => {
        resolve(fullText);
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(JSON.stringify(opts));
    req.end();

    cancelToken.onCancellationRequested(() => {
      req.destroy();
      resolve();
    });
  });
};
