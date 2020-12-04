/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient';

/**
 * Represent a vscode command with an ID and an impl function `execute`.
 */
interface Command {
  id: string;
  execute(): unknown;
}

/**
 * Restart the language server by killing the process then spanwing a new one.
 * @param client language client
 */
function restartNgServer(client: lsp.LanguageClient): Command {
  return {
    id: 'angular.restartNgServer',
    async execute() {
      await client.stop();
      return client.start();
    },
  };
}

function offset2Pos(offset: number, source: string): [number, number] {
  let cur = 0;
  // Use split_terminator instead of lines so that if there is a `\r`,
  // it is included in the offset calculation. The `+1` values below
  // account for the `\n`.
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];
    if (cur + line.length + 1 > offset) {
      return [i, offset - cur];
    }
    cur += line.length + 1;
  }
  return [lines.length, 0];
}

const TCB_HI_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
});

interface GetTcbParams {
  textDocument: lsp.TextDocumentIdentifier;
  position: lsp.Position;
}
type GetTcbResponse = {
  content: string,
  start: number,
  end: number,
}|{
  error: string,
};
const lspGetTcb = new lsp.RequestType<GetTcbParams, GetTcbResponse, void>('ng/getTcb');

function getTcb(client: lsp.LanguageClient, context: vscode.ExtensionContext): Command {
  let start = new vscode.Position(0, 0);
  let end = start;

  class TcbDocumentProvider implements vscode.TextDocumentContentProvider {
    readonly uri = vscode.Uri.parse('ng://getTcb/ngtypecheck.ts');
    readonly eventEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.eventEmitter.event;

    constructor() {
      vscode.workspace.onDidChangeTextDocument(
          this.onDidChangeTextDocument, this, context.subscriptions);
      vscode.window.onDidChangeActiveTextEditor(
          this.onDidChangeActiveTextEditor, this, context.subscriptions);
    }

    private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
      if (event.document.fileName.endsWith('html')) {
        // We need to order this after language server updates, but there's no API for that.
        // Hence, good old sleep().
        void new Promise((resolve) => setTimeout(resolve, 10))
            .then(() => this.eventEmitter.fire(this.uri));
      }
    }
    private onDidChangeActiveTextEditor(editor: vscode.TextEditor|undefined) {
      if (editor && editor.document.languageId === 'rust' &&
          editor.document.uri.scheme === 'file') {
        this.eventEmitter.fire(this.uri);
      }
    }

    async provideTextDocumentContent(): Promise<string> {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) return 'Active editor not found.';

      const expanded = await client.sendRequest(lspGetTcb, {
        textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(activeEditor.document),
        position: activeEditor.selection.active,
      });

      if ('content' in expanded) {
        const pStart = offset2Pos(expanded.start, expanded.content);
        const pEnd = offset2Pos(expanded.end, expanded.content);
        start = new vscode.Position(pStart[0], pStart[1]);
        end = new vscode.Position(pEnd[0], pEnd[1]);
        return expanded.content;
      };
      return `Typecheck block not available: ${expanded.error}`;
    }
  }

  const tcbProvider = new TcbDocumentProvider();

  const disposeNgProvider = vscode.workspace.registerTextDocumentContentProvider('ng', tcbProvider);
  context.subscriptions.push(disposeNgProvider);

  return {
    id: 'angular.getTemplateTcb',
    execute: async function() {
      const document = await vscode.workspace.openTextDocument(tcbProvider.uri);
      // Notify VSCode of a change to the TCB virtual document, prompting it to re-evaluate the
      // document content.
      // https://code.visualstudio.com/api/extension-guides/virtual-documents#update-virtual-documents
      tcbProvider.eventEmitter.fire(tcbProvider.uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      });
      // TODO: we could update this automatically by providing a text document highlight provider.
      editor.setDecorations(TCB_HI_DECORATION, [
        new vscode.Range(start, end),
      ]);
    }
  };
}

interface DesugarTemplateParams {
  textDocument: lsp.TextDocumentIdentifier;
  position: lsp.Position;
}
type DesugarTemplateResponse = string|undefined;
const lspGetDesugaredTemplate =
    new lsp.RequestType<DesugarTemplateParams, DesugarTemplateResponse, void>(
        'ng/getDesugaredTemplate');

function getDesugaredTemplate(
    client: lsp.LanguageClient, context: vscode.ExtensionContext): Command {
  class TcbDocumentProvider implements vscode.TextDocumentContentProvider {
    readonly uri = vscode.Uri.parse('ngtemplate://template/desugared.html');
    readonly eventEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.eventEmitter.event;

    async provideTextDocumentContent(): Promise<string> {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) return 'Active editor not found.';

      const expanded = await client.sendRequest(lspGetDesugaredTemplate, {
        textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(activeEditor.document),
        position: activeEditor.selection.active,
      });

      client.info(`recv response: ${expanded}`);

      return expanded ?? 'Failed to find template under cursor.';
    }
  }

  const tcbProvider = new TcbDocumentProvider();

  const disposeNgProvider =
      vscode.workspace.registerTextDocumentContentProvider('ngtemplate', tcbProvider);
  context.subscriptions.push(disposeNgProvider);

  return {
    id: 'angular.desugarTemplate',
    execute: async function() {
      const document = await vscode.workspace.openTextDocument(tcbProvider.uri);
      tcbProvider.eventEmitter.fire(tcbProvider.uri);
      return vscode.window.showTextDocument(
          document,
          vscode.ViewColumn.Two,
          true,
      );
    }
  };
}

/**
 * Register all supported vscode commands for the Angular extension.
 * @param client language client
 */
export function registerCommands(client: lsp.LanguageClient, context: vscode.ExtensionContext) {
  const commands: Command[] = [
    restartNgServer(client),
    getTcb(client, context),
    getDesugaredTemplate(client, context),
  ];

  const disposables = commands.map((command) => {
    return vscode.commands.registerCommand(command.id, command.execute);
  });

  context.subscriptions.push(...disposables);
}
