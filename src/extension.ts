import * as vscode from 'vscode';
import { PreviewPanel } from './PreviewPanel';
import { PasteImageHandler } from './PasteImageHandler';
import { MarkdownFolioEditorProvider } from './MarkdownFolioEditorProvider';

async function resolveMarkdownDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri) {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.languageId === 'markdown' || uri.path.toLowerCase().endsWith('.md')) {
            return document;
        }
        return undefined;
    }

    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && (activeDoc.languageId === 'markdown' || activeDoc.uri.path.toLowerCase().endsWith('.md'))) {
        return activeDoc;
    }
    return undefined;
}

export function activate(context: vscode.ExtensionContext) {
    const channel = vscode.window.createOutputChannel('Markdown Folio');
    channel.appendLine('Markdown Folio activating...');

    // Register as a custom editor — appears in "Select editor for *.md" dropdown
    context.subscriptions.push(
        vscode.commands.registerCommand('markdownFolio.pasteImage', () => {
            PasteImageHandler.handlePasteImage();
        })
    );

    context.subscriptions.push(MarkdownFolioEditorProvider.register(context));

    const openPreview = vscode.commands.registerCommand('markdownFolio.openPreview', async (uri?: vscode.Uri) => {
        channel.appendLine('markdownFolio.openPreview invoked');
        const document = await resolveMarkdownDocument(uri);

        if (document) {
            PreviewPanel.createOrShow(context, document);
            channel.appendLine(`Opened preview for ${document.uri.fsPath}`);
        } else {
            vscode.window.showErrorMessage('Markdown Folio: Active editor must be a Markdown file.');
            channel.appendLine('Open preview failed: active editor is not a Markdown file.');
        }
    });

    const togglePreview = vscode.commands.registerCommand('markdownFolio.togglePreview', async (uri?: vscode.Uri) => {
        channel.appendLine('markdownFolio.togglePreview invoked');
        if (!uri && PreviewPanel.activePanel?.isActive) {
            await PreviewPanel.activePanel.showSource();
            channel.appendLine('Toggled preview -> source editor');
            return;
        }

        const document = await resolveMarkdownDocument(uri);
        if (document) {
            PreviewPanel.createOrShow(context, document);
            channel.appendLine(`Toggled source editor -> preview for ${document.uri.fsPath}`);
        } else {
            vscode.window.showErrorMessage('Markdown Folio: Active editor must be a Markdown file.');
            channel.appendLine('Toggle preview failed: active editor is not a Markdown file.');
        }
    });

    context.subscriptions.push(openPreview, togglePreview);

    // Status bar button — one-click access to preview for markdown files
    const statusBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBtn.text = '$(book) Folio';
    statusBtn.tooltip = 'Open Markdown Folio Preview';
    statusBtn.command = 'markdownFolio.openPreview';
    context.subscriptions.push(statusBtn);

    function updateStatusBar() {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'markdown') {
            statusBtn.show();
        } else {
            statusBtn.hide();
        }
    }
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBar));
    updateStatusBar();

    context.subscriptions.push(channel);
    channel.appendLine('Markdown Folio activated.');
}

export function deactivate() { }
