import * as vscode from 'vscode';
import * as path from 'path';
import { MarkdownEngine } from './engine/MarkdownEngine';
import { PathResolver } from './utils/pathResolver';
import { FrontmatterParser } from './engine/FrontmatterParser';
import { debounce } from './utils/debounce';
import { SettingsManager } from './SettingsManager';
import { HtmlBuilder } from './HtmlBuilder';
import { HtmlExporter } from './HtmlExporter';

export class PreviewPanel {
    private static _markdownEngineInstance?: MarkdownEngine;
    private static get _markdownEngine(): MarkdownEngine {
        if (!PreviewPanel._markdownEngineInstance) {
            PreviewPanel._markdownEngineInstance = new MarkdownEngine();
        }
        return PreviewPanel._markdownEngineInstance;
    }
    public static currentPanel: PreviewPanel | undefined;
    public static activePanel: PreviewPanel | undefined;
    private static readonly _panels = new Set<PreviewPanel>();

    private static _syncActiveContext(): void {
        const active = Array.from(PreviewPanel._panels).find(panel => panel._panel.active);
        PreviewPanel.activePanel = active;
        void vscode.commands.executeCommand('setContext', 'markdownFolio.previewActive', Boolean(active));
    }
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _document: vscode.TextDocument;
    private _disposables: vscode.Disposable[] = [];
    private _debounceUpdate = debounce(() => this._update(), 300);
    private _hasPendingRender = true;
    private _hasPendingSettings = false;
    private _htmlInitialized = false;
    private _webviewReady = false;
    private _lastRenderedHtml = '';
    private _lastToc: import('./shared/types').TocItem[] = [];
    private _lastTitle = '';
    private _cachedDocKey = '';
    private _cachedRender: {
        html: string;
        toc: import('./shared/types').TocItem[];
        metadata: { title?: string; author?: string; date?: string };
        title: string;
        panelTitle: string;
    } | null = null;
    private _lastDeliveredKey = '';
    private _scrollEventCounter = 0;
    private _scrollThrottleTimer: NodeJS.Timeout | null = null;
    private _pendingScrollLine = 0;
    private _mode: 'side' | 'customEditor' = 'side';
    private _suppressForwardScrollUntil = 0;
    private _disposed = false;

    /**
     * Used by MarkdownFolioEditorProvider: VS Code supplies the panel, we just initialise it.
     * Does NOT set currentPanel — custom editor instances are managed by VS Code.
     */
    public static createFromExternalPanel(
        context: vscode.ExtensionContext,
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel
    ): PreviewPanel {
        panel.webview.options = PreviewPanel._getWebviewOptions(context.extensionUri, document);
        const instance = new PreviewPanel(panel, context.extensionUri, document);
        instance._mode = 'customEditor';
        return instance;
    }

    private static _getWebviewOptions(extensionUri: vscode.Uri, document: vscode.TextDocument): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'dist'),
                ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
                vscode.Uri.file(path.dirname(document.fileName))
            ]
        };
    }

    public static createOrShow(context: vscode.ExtensionContext, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        // If we already have a panel, show it.
        if (PreviewPanel.currentPanel) {
            const current = PreviewPanel.currentPanel;
            const docChanged = current._document.uri.toString() !== document.uri.toString();
            current._document = document;
            if (docChanged) {
                current._panel.webview.options = PreviewPanel._getWebviewOptions(context.extensionUri, document);
                current._lastRenderedHtml = '';
                current._cachedDocKey = '';
                current._cachedRender = null;
                current._lastDeliveredKey = '';
                current._hasPendingRender = true;
                current._panel.title = `Preview: ${path.basename(document.fileName)}`;
            }
            current._panel.reveal(current._panel.viewColumn ?? column);
            if (current._hasPendingRender || current._hasPendingSettings) {
                current._update();
            }
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'markdownFolioPreview',
            `Preview: ${path.basename(document.fileName)}`,
            column || vscode.ViewColumn.One,
            {
                ...PreviewPanel._getWebviewOptions(context.extensionUri, document),
                retainContextWhenHidden: true
            }
        );

        PreviewPanel.currentPanel = new PreviewPanel(panel, context.extensionUri, document);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, document: vscode.TextDocument) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._document = document;

        PreviewPanel._panels.add(this);
        PreviewPanel._syncActiveContext();

        // Set the webview shell first; render content after the webview signals ready.
        this._initializeWebview();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Listen for file changes (skip metadata-only changes such as dirty/save events)
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === this._document && e.contentChanges.length > 0) {
                this._hasPendingRender = true;
                this._debounceUpdate();
            }
        }, null, this._disposables);

        // Listen for view state changes
        this._panel.onDidChangeViewState(() => {
            PreviewPanel._syncActiveContext();
            if (!this._panel.visible) { return; }
            if (this._hasPendingRender) {
                this._update();
            } else if (this._hasPendingSettings && this._webviewReady) {
                this._hasPendingSettings = false;
                this._panel.webview.postMessage({
                    type: 'settings-updated',
                    payload: SettingsManager.read()
                });
            }
        }, null, this._disposables);

        // Forward scroll sync: editor visible range → preview
        this._disposables.push(
            vscode.window.onDidChangeTextEditorVisibleRanges(e => {
                if (e.textEditor.document !== this._document) { return; }
                if (!this._panel.visible) { return; }
                if (!SettingsManager.read().scrollSync) { return; }
                if (Date.now() < this._suppressForwardScrollUntil) { return; }
                this._pendingScrollLine = e.textEditor.visibleRanges[0]?.start.line ?? 0;
                // Throttle at ~50ms, but always send the latest observed line.
                if (this._scrollThrottleTimer) { return; }
                this._scrollThrottleTimer = setTimeout(() => {
                    this._scrollThrottleTimer = null;
                    this._panel.webview.postMessage({
                        type: 'scroll-to-line',
                        payload: { line: this._pendingScrollLine, eventId: ++this._scrollEventCounter }
                    });
                }, 50);
            })
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'ready':
                        this._webviewReady = true;
                        this._update();
                        return;
                    case 'alert':
                        vscode.window.showErrorMessage(message.payload);
                        return;
                    case 'update-settings':
                        SettingsManager.update(message.payload).catch(err => {
                            vscode.window.showErrorMessage(`Markdown Folio: Failed to save settings: ${err}`);
                        });
                        return;
                    case 'export-pdf': {
                        const { orientation, size } = message.payload as {
                            orientation: 'portrait' | 'landscape';
                            size: 'A4' | 'A3' | 'Letter';
                        };
                        this._handleExportPdf(orientation, size);
                        return;
                    }
                    case 'export-html': {
                        this._handleExportHtml();
                        return;
                    }
                    case 'export-png-full':
                        this._handleExportPng('full');
                        return;
                    case 'export-png-pages':
                        this._handleExportPng('pages');
                        return;
                    case 'copy': {
                        const payload = message.payload;
                        this._handleCopy(payload);
                        return;
                    }
                    case 'export-docx':
                        this._handleExportDocx();
                        return;
                    case 'reveal-line': {
                        this._handleRevealLine(message.payload);
                        return;
                    }
                    case 'open-workspace-file': {
                        this._handleOpenWorkspaceFile(message.payload);
                        return;
                    }
                    case 'resolve-image-data-uri': {
                        this._handleResolveImageDataUri(message.payload);
                        return;
                    }
                    case 'resolve-text-preview': {
                        this._handleResolveTextPreview(message.payload);
                        return;
                    }
                }
            },
            null,
            this._disposables
        );

        // Listen for VS Code settings changes → push to webview immediately or defer until visible
        this._disposables.push(
            SettingsManager.onDidChange(settings => {
                if (this._panel.visible && this._webviewReady) {
                    this._hasPendingSettings = false;
                    this._panel.webview.postMessage({
                        type: 'settings-updated',
                        payload: settings
                    });
                } else {
                    this._hasPendingSettings = true;
                }
            })
        );
    }

    public get isActive(): boolean {
        return this._panel.active;
    }

    /**
     * Switch from the active preview back to its source Markdown text editor.
     */
    public async showSource(): Promise<void> {
        const uri = this._document.uri;
        if (this._mode === 'customEditor') {
            await vscode.commands.executeCommand(
                'vscode.openWith',
                uri,
                'default',
                this._panel.viewColumn
            );
            return;
        }

        const existingEditor = vscode.window.visibleTextEditors.find(
            editor => editor.document.uri.toString() === uri.toString()
        );
        if (existingEditor) {
            await vscode.window.showTextDocument(existingEditor.document, {
                viewColumn: existingEditor.viewColumn,
                preserveFocus: false
            });
            return;
        }

        const doc = this._document.isClosed
            ? await vscode.workspace.openTextDocument(uri)
            : this._document;
        await vscode.window.showTextDocument(doc, {
            viewColumn: this._panel.viewColumn,
            preserveFocus: false
        });
    }

    public dispose() {
        if (this._disposed) { return; }
        this._disposed = true;
        PreviewPanel._panels.delete(this);
        if (PreviewPanel.currentPanel === this) {
            PreviewPanel.currentPanel = undefined;
        }
        PreviewPanel._syncActiveContext();

        // Clean up our resources
        if (this._scrollThrottleTimer) {
            clearTimeout(this._scrollThrottleTimer);
            this._scrollThrottleTimer = null;
        }
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _guardContent(): boolean {
        if (!this._lastRenderedHtml) {
            vscode.window.showWarningMessage('Markdown Folio: No content to export. Please open a Markdown file first.');
            return false;
        }
        return true;
    }

    private _handleRevealLine(payload: { line: number; eventId?: number }): void {
        // Custom editor mode: never auto-open text editor
        if (this._mode === 'customEditor') { return; }
        // Respect scrollSync setting
        if (!SettingsManager.read().scrollSync) { return; }
        // Only reveal if a visible text editor is already showing this document
        const editor = vscode.window.visibleTextEditors.find(e => e.document === this._document);
        if (!editor) { return; }
        const line = payload.line ?? 0;
        if (this._scrollThrottleTimer) {
            clearTimeout(this._scrollThrottleTimer);
            this._scrollThrottleTimer = null;
        }
        this._suppressForwardScrollUntil = Date.now() + 500;
        editor.revealRange(
            new vscode.Range(line, 0, line, 0),
            vscode.TextEditorRevealType.AtTop
        );
    }

    private _handleResolveImageDataUri(payload: { requestId?: string; path?: string }): void {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
        if (!requestId || !rawPath) { return; }

        const documentDir = path.dirname(this._document.fileName);
        const dataUri = PathResolver.readImageDataUriForLink(rawPath, documentDir, this._document.uri);
        void this._panel.webview.postMessage({
            type: 'image-data-uri-resolved',
            payload: { requestId, dataUri }
        });
    }

    private _handleResolveTextPreview(payload: { requestId?: string; path?: string }): void {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
        if (!requestId || !rawPath) { return; }

        const documentDir = path.dirname(this._document.fileName);
        const preview = PathResolver.readTextPreviewForLink(rawPath, documentDir, this._document.uri);
        void this._panel.webview.postMessage({
            type: 'text-preview-resolved',
            payload: { requestId, preview }
        });
    }

    private async _handleOpenWorkspaceFile(payload: { path?: string }): Promise<void> {
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
        if (!rawPath) { return; }

        const hashMatch = rawPath.match(/^([^#]+)#L(\d+)(?:-L?(\d+))?$/i);
        const withoutQuery = PathResolver.stripQueryAndHash(hashMatch ? hashMatch[1] : rawPath);
        const lineMatch = /^file:\/\//i.test(withoutQuery)
            ? withoutQuery.match(/^(file:\/\/.+?):(\d+)(?::(\d+))?$/i)
            : withoutQuery.match(/^(.+?):(\d+)(?::(\d+))?$/);
        const filePart = lineMatch?.[1] ?? withoutQuery;
        const lineNum = hashMatch?.[2]
            ? Math.max(0, parseInt(hashMatch[2], 10) - 1)
            : (lineMatch?.[2] ? Math.max(0, parseInt(lineMatch[2], 10) - 1) : undefined);
        const colNum = lineMatch?.[3] ? Math.max(0, parseInt(lineMatch[3], 10) - 1) : 0;

        const docDir = path.dirname(this._document.fileName);
        const targetPath = PathResolver.resolveCandidateFile(filePart, docDir, this._document.uri);

        if (!targetPath) {
            this._panel.webview.postMessage({
                type: 'toast',
                payload: { message: `未找到工作区文件：${filePart}`, tone: 'warn' }
            });
            return;
        }

        const uri = vscode.Uri.file(targetPath);
        try {
            if (lineNum !== undefined) {
                const doc = await vscode.workspace.openTextDocument(uri);
                const maxLine = Math.max(0, doc.lineCount - 1);
                const startLine = Math.min(lineNum, maxLine);
                const endLine = hashMatch?.[3]
                    ? Math.min(Math.max(startLine, parseInt(hashMatch[3], 10) - 1), maxLine)
                    : startLine;
                const startPos = new vscode.Position(startLine, colNum);
                const endPos = endLine > startLine
                    ? new vscode.Position(endLine, doc.lineAt(endLine).text.length)
                    : startPos;
                const selection = new vscode.Range(startPos, endPos);
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: false,
                    selection
                });
                editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            } else {
                await vscode.commands.executeCommand('vscode.open', uri);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: 无法打开文件 ${filePart} — ${err?.message ?? err}`);
        }
    }

    private async _handleExportPdf(
        orientation: 'portrait' | 'landscape',
        size: 'A4' | 'A3' | 'Letter'
    ): Promise<void> {
        if (!this._guardContent()) { return; }
        try {
            const defaultName = path.basename(this._document.fileName, '.md') + '.pdf';
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(
                    path.join(path.dirname(this._document.fileName), defaultName)
                ),
                filters: { 'PDF Files': ['pdf'] },
            });

            if (!saveUri) {
                return; // user cancelled
            }

            const distDir = path.join(this._extensionUri.fsPath, 'dist');
            const settings = SettingsManager.read();
            const pdfHtml = HtmlBuilder.buildPdfHtml({
                html: this._buildExportHtml(),
                distDir,
                settings,
                title: this._lastTitle,
            });

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Markdown Folio: Exporting PDF...',
                    cancellable: false,
                },
                async () => {
                    const { PdfExporter } = await import('./PdfExporter');
                    await PdfExporter.export(pdfHtml, {
                        orientation,
                        size,
                        outputPath: saveUri.fsPath,
                        headings: this._lastToc.filter(h => h.level <= 3),
                    });
                }
            );

            const open = await vscode.window.showInformationMessage(
                `PDF exported: ${path.basename(saveUri.fsPath)}`,
                'Open file'
            );
            if (open === 'Open file') {
                vscode.env.openExternal(saveUri);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: PDF export failed — ${err.message}`);
        }
    }

    private async _handleCopy(payload: any) {
        if (!this._guardContent()) return;
        try {
            if (payload.mode === 'notion-markdown') {
                const markdown = this._buildNotionMarkdownSource();
                await vscode.env.clipboard.writeText(markdown);
                vscode.window.showInformationMessage('Markdown copied for Notion');
            } else if (payload.mode === 'rich-html-fallback') {
                const text = payload.html || payload.text || '';
                await vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage('Copied (Fallback Text/HTML)');
            } else if (payload.mode === 'plain-text-fallback') {
                await vscode.env.clipboard.writeText(payload.text || '');
                vscode.window.showInformationMessage('Copied (Plain Text)');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: Copy failed - ${err.message}`);
        }
    }

    private _buildNotionMarkdownSource(): string {
        const text = this._document.getText().replace(/\r\n/g, '\n');
        return FrontmatterParser.extract(text).content.replace(/\r\n/g, '\n').trim();
    }

    private _buildExportHtml(): string {
        const documentContent = this._document.getText();
        const documentDir = path.dirname(this._document.fileName);
        const { content, lineOffset } = FrontmatterParser.extract(documentContent);
        const exportContent = PathResolver.resolveImages(content, documentDir);
        return PreviewPanel._markdownEngine.render(exportContent, lineOffset);
    }

    private async _handleExportHtml(): Promise<void> {
        if (!this._guardContent()) { return; }
        try {
            const defaultName = path.basename(this._document.fileName, '.md') + '.html';
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(this._document.fileName), defaultName)),
                filters: { 'HTML Files': ['html'] },
            });
            if (!saveUri) { return; }

            const distDir = path.join(this._extensionUri.fsPath, 'dist');
            const settings = SettingsManager.read();
            const exportHtml = HtmlBuilder.buildExportHtml({
                html: this._buildExportHtml(),
                distDir,
                settings,
                title: this._lastTitle,
                toc: this._lastToc,
            });

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Markdown Folio: Exporting HTML...', cancellable: false },
                async () => { HtmlExporter.export(exportHtml, saveUri.fsPath); }
            );

            const open = await vscode.window.showInformationMessage(
                `HTML exported: ${path.basename(saveUri.fsPath)}`, 'Open file'
            );
            if (open === 'Open file') { vscode.env.openExternal(saveUri); }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: HTML export failed — ${err.message}`);
        }
    }

    private async _handleExportPng(mode: 'full' | 'pages'): Promise<void> {
        if (!this._guardContent()) { return; }
        try {
            const baseName = path.basename(this._document.fileName, '.md');
            const distDir = path.join(this._extensionUri.fsPath, 'dist');
            const settings = SettingsManager.read();
            const pngHtml = HtmlBuilder.buildExportHtml({
                html: this._buildExportHtml(),
                distDir,
                settings,
                title: this._lastTitle,
                toc: this._lastToc,
                exportOptions: { compactPaper: mode === 'full', pngCapture: true },
            });

            if (mode === 'full') {
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(path.dirname(this._document.fileName), `${baseName}.png`)),
                    filters: { 'PNG Image': ['png'] },
                });
                if (!saveUri) { return; }

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Markdown Folio: Exporting PNG...', cancellable: false },
                    async () => {
                        const { PngExporter } = await import('./PngExporter');
                        await PngExporter.export(pngHtml, { outputPath: saveUri.fsPath, mode: 'full' });
                    }
                );
                const open = await vscode.window.showInformationMessage(
                    `PNG exported: ${path.basename(saveUri.fsPath)}`, 'Open file'
                );
                if (open === 'Open file') { vscode.env.openExternal(saveUri); }
            } else {
                // Pages mode: chọn folder
                const folderUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(path.dirname(this._document.fileName), `${baseName}-pages`)),
                    filters: { 'Folder name (no extension)': [''] },
                    title: 'Select output folder for PNG pages',
                });
                if (!folderUri) { return; }

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Markdown Folio: Exporting PNG pages...', cancellable: false },
                    async () => {
                        const { PngExporter } = await import('./PngExporter');
                        await PngExporter.export(pngHtml, { outputPath: folderUri.fsPath, mode: 'pages' });
                    }
                );
                const open = await vscode.window.showInformationMessage(
                    `PNG pages exported to: ${path.basename(folderUri.fsPath)}`, 'Open folder'
                );
                if (open === 'Open folder') { vscode.env.openExternal(folderUri); }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: PNG export failed — ${err.message}`);
        }
    }

    private async _handleExportDocx(): Promise<void> {
        if (!this._guardContent()) { return; }
        try {
            const defaultName = path.basename(this._document.fileName, '.md') + '.docx';
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(this._document.fileName), defaultName)),
                filters: { 'Word Document': ['docx'] },
            });
            if (!saveUri) { return; }

            const distDir = path.join(this._extensionUri.fsPath, 'dist');
            const settings = SettingsManager.read();

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Markdown Folio: Exporting DOCX...', cancellable: false },
                async () => {
                    const { DocxExporter } = await import('./DocxExporter');
                    await DocxExporter.export(this._buildExportHtml(), {
                        outputPath: saveUri.fsPath,
                        title: this._lastTitle,
                        distDir,
                        settings,
                    });
                }
            );

            const open = await vscode.window.showInformationMessage(
                `DOCX exported: ${path.basename(saveUri.fsPath)}`, 'Open file'
            );
            if (open === 'Open file') { vscode.env.openExternal(saveUri); }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Markdown Folio: DOCX export failed — ${err.message}`);
        }
    }

    private _initializeWebview() {
        if (!this._htmlInitialized) {
            this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
            this._htmlInitialized = true;
        }
    }

    private _update() {
        this._initializeWebview();

        if (!this._panel.visible || !this._webviewReady) {
            this._hasPendingRender = true;
            return;
        }

        const docKey = `${this._document.uri.toString()}::${this._document.version}`;
        if (this._lastDeliveredKey === docKey && !this._hasPendingSettings && !this._hasPendingRender) {
            return;
        }

        let rendered = this._cachedDocKey === docKey ? this._cachedRender : null;
        if (!rendered) {
            const webview = this._panel.webview;
            const documentContent = this._document.getText();
            const documentDir = path.dirname(this._document.fileName);

            const { title, author, date, content, lineOffset } = FrontmatterParser.extract(documentContent);
            const previewContent = PathResolver.resolveImagesForWebview(content, documentDir, webview);
            const { html, toc } = PreviewPanel._markdownEngine.renderWithToc(previewContent, lineOffset);
            const annotatedHtml = PathResolver.annotateLocalEvidenceForWebview(html, documentDir, webview, this._document.uri);

            rendered = {
                html: annotatedHtml,
                toc,
                metadata: { title, author, date },
                title: title || path.basename(this._document.fileName, '.md'),
                panelTitle: `Preview: ${title || path.basename(this._document.fileName)}`
            };
            this._cachedDocKey = docKey;
            this._cachedRender = rendered;
        }

        this._lastRenderedHtml = rendered.html;
        this._lastToc = rendered.toc;
        this._lastTitle = rendered.title;
        this._panel.title = rendered.panelTitle;

        const settings = SettingsManager.read();
        this._panel.webview.postMessage({
            type: 'render',
            payload: {
                html: rendered.html,
                toc: rendered.toc,
                metadata: rendered.metadata,
                config: settings
            }
        });
        this._lastDeliveredKey = docKey;
        this._hasPendingRender = false;
        this._hasPendingSettings = false;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'katex.css'));
        const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'mermaid.min.js'));
        const fontsBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'fonts'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} data:;">
                <style>
                    @font-face {
                        font-family: 'DM Sans';
                        font-style: normal;
                        font-weight: 400;
                        font-display: swap;
                        src: url('${fontsBaseUri}/dm-sans-latin-400-normal.woff2') format('woff2');
                    }
                    @font-face {
                        font-family: 'DM Sans';
                        font-style: normal;
                        font-weight: 500;
                        font-display: swap;
                        src: url('${fontsBaseUri}/dm-sans-latin-500-normal.woff2') format('woff2');
                    }
                    @font-face {
                        font-family: 'DM Serif Display';
                        font-style: normal;
                        font-weight: 400;
                        font-display: swap;
                        src: url('${fontsBaseUri}/dm-serif-display-latin-400-normal.woff2') format('woff2');
                    }
                    @font-face {
                        font-family: 'Merriweather';
                        font-style: normal;
                        font-weight: 400;
                        font-display: swap;
                        src: url('${fontsBaseUri}/merriweather-latin-400-normal.woff2') format('woff2');
                    }
                    @font-face {
                        font-family: 'Merriweather';
                        font-style: normal;
                        font-weight: 700;
                        font-display: swap;
                        src: url('${fontsBaseUri}/merriweather-latin-700-normal.woff2') format('woff2');
                    }
                </style>
                <link rel="stylesheet" href="${katexCssUri}">
                <title>Markdown Folio Preview</title>
            </head>
            <body data-mermaid-src="${mermaidUri}">
                <div id="reading-progress-bar"></div>
                <button id="toc-drawer-toggle" class="toc-drawer-fab" title="Toggle Table of Contents">
                    <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                    <span>Contents</span>
                </button>
                <div id="toolbar" class="collapsed">
                    <button class="export-pill export-pdf-toggle" id="pdf-dropdown-toggle" title="Export PDF">
                        Export PDF <svg class="dropdown-icon" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <button class="export-pill" id="export-html" title="Export HTML">HTML</button>
                    <button class="export-pill export-pdf-toggle" id="copy-dropdown-toggle" title="Copy">
                        Copy <svg class="dropdown-icon" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <button class="export-pill export-pdf-toggle" id="png-dropdown-toggle" title="Export PNG">
                        PNG <svg class="dropdown-icon" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <button class="export-pill" id="export-docx" title="Export DOCX">DOCX</button>
                    <div class="toolbar-sep"></div>
                    <button class="toolbar-btn" id="settings-dropdown-toggle" title="Preview Settings">
                        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        <span class="tb-label">Settings</span>
                    </button>
                    <div class="toolbar-sep"></div>
                    <div class="zoom-controls">
                        <button id="zoom-out" class="zoom-btn" title="Zoom out">-</button>
                        <span id="zoom-label">100%</span>
                        <button id="zoom-in" class="zoom-btn" title="Zoom in">+</button>
                    </div>
                    <div class="toolbar-sep"></div>
                    <button class="toolbar-btn" id="theme-dropdown-toggle" title="Preview Theme">
                        <span class="tb-label" id="theme-label">Theme</span>
                        <svg class="dropdown-icon" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <div class="toolbar-sep"></div>
                    <button class="toolbar-btn" id="toolbar-find-btn" title="页内检索 (Cmd/Ctrl+F)">
                        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    </button>
                    <span id="toolbar-collapsed-meta" class="toolbar-collapsed-meta" title="Expand Toolbar">100%</span>
                    <button class="toolbar-btn" id="toolbar-toggle" title="Expand Toolbar">
                        <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                </div>

                <div id="copy-dropdown" class="dropdown-menu">
                    <div class="popover-group">
                        <button id="copy-rich-html" class="toolbar-btn"><span class="tb-label">Rich HTML</span></button>
                        <button id="copy-notion-markdown" class="toolbar-btn"><span class="tb-label">Notion Markdown</span></button>
                        <button id="copy-plain-text" class="toolbar-btn"><span class="tb-label">Plain Text</span></button>
                    </div>
                </div>

                <div id="png-dropdown" class="dropdown-menu">
                    <div class="popover-group">
                        <button id="export-png-full" class="toolbar-btn">
                            <span class="tb-label">Full Page</span>
                            <span class="export-pdf-badge" style="font-size:10px;opacity:0.6">1 image</span>
                        </button>
                        <button id="export-png-pages" class="toolbar-btn">
                            <span class="tb-label">Per Page</span>
                            <span class="export-pdf-badge" style="font-size:10px;opacity:0.6">A4 pages</span>
                        </button>
                    </div>
                </div>

                <div id="theme-dropdown" class="dropdown-menu">
                    <div class="popover-group">
                        <button class="toolbar-btn theme-btn" data-theme="admiral"><span class="tb-label">Admiral</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="ivory"><span class="tb-label">Ivory</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="serene"><span class="tb-label">Serene</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="cyberpunk"><span class="tb-label">Cyberpunk</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="dracula"><span class="tb-label">Dracula</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="github"><span class="tb-label">GitHub</span></button>
                        <button class="toolbar-btn theme-btn" data-theme="zen"><span class="tb-label">Zen</span></button>
                    </div>
                </div>

                <div id="pdf-dropdown" class="dropdown-menu">
                    <div class="popover-group">
                        <div class="pop-section-label">Orientation</div>
                        <div class="orient-row">
                            <button class="orient-btn active" data-orientation="portrait">Portrait</button>
                            <button class="orient-btn" data-orientation="landscape">Landscape</button>
                        </div>
                    </div>
                    <div class="popover-group">
                        <div class="pop-section-label">Paper Size</div>
                        <div class="size-row">
                            <button class="size-chip active" data-size="A4">A4</button>
                            <button class="size-chip" data-size="A3">A3</button>
                            <button class="size-chip" data-size="Letter">Letter</button>
                        </div>
                    </div>
                    <div class="popover-divider"></div>
                    <div class="popover-group">
                        <button id="export-pdf" class="toolbar-btn">
                            <span class="tb-label">Export PDF</span>
                            <span id="export-pdf-badge">A4 · Portrait</span>
                        </button>
                    </div>
                </div>

                <div id="settings-dropdown" class="dropdown-menu">
                    <div class="popover-group">
                        <div class="pop-section-label">Typography</div>
                        <div class="set-row set-row-font">
                            <span class="set-row-label">Font</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="font">System</button>
                                <button class="set-chip" data-group="font">Editorial</button>
                                <button class="set-chip" data-group="font">Georgia</button>
                                <button class="set-chip" data-group="font">Charter</button>
                                <button class="set-chip" data-group="font">Songti</button>
                                <button class="set-chip" data-group="font">Mono</button>
                            </div>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Size</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="font-size">S</button>
                                <button class="set-chip active" data-group="font-size">M</button>
                                <button class="set-chip" data-group="font-size">L</button>
                            </div>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Heading</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="heading-size">S</button>
                                <button class="set-chip active" data-group="heading-size">M</button>
                                <button class="set-chip" data-group="heading-size">L</button>
                            </div>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Line spacing</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="line-spacing" data-value="compact">Compact</button>
                                <button class="set-chip" data-group="line-spacing" data-value="normal">Normal</button>
                                <button class="set-chip" data-group="line-spacing" data-value="relaxed">Relaxed</button>
                            </div>
                        </div>
                    </div>
                    <div class="popover-divider"></div>
                    <div class="popover-group">
                        <div class="pop-section-label">Layout</div>
                        <div class="set-row">
                            <span class="set-row-label">Page width</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="page-width" data-value="narrow">Narrow</button>
                                <button class="set-chip" data-group="page-width" data-value="standard">Standard</button>
                                <button class="set-chip" data-group="page-width" data-value="wide">Wide</button>
                                <button class="set-chip" data-group="page-width" data-value="fluid">Fluid</button>
                                <button class="set-chip" data-group="page-width" data-value="full">Full</button>
                            </div>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Table wrap</span>
                            <div class="set-chips">
                                <button class="set-chip" data-group="table-wrap" data-value="0" title="Always wrap inside paper width">Auto</button>
                                <button class="set-chip" data-group="table-wrap" data-value="240" title="Wrap columns wider than 240px">240</button>
                                <button class="set-chip active" data-group="table-wrap" data-value="320" title="Wrap columns wider than 320px (default)">320</button>
                                <button class="set-chip" data-group="table-wrap" data-value="420" title="Wrap columns wider than 420px">420</button>
                            </div>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">TOC Sidebar</span>
                            <span class="set-toggle on" data-action="toc-sidebar"></span>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Click code copy</span>
                            <span class="set-toggle on" data-action="click-inline-code-copy"></span>
                        </div>
                        <div class="set-row">
                            <span class="set-row-label">Expand image links</span>
                            <span class="set-toggle" data-action="expand-image-links"></span>
                        </div>
                        <div class="set-row" title="智能文档结构重组（摘要指标、缺陷卡片、冒号子标题、键值对齐、表后关联列、章节折叠）">
                            <span class="set-row-label">Smart doc restructure</span>
                            <span class="set-toggle on" data-action="smart-doc-restructure"></span>
                        </div>
                        <div class="set-row" title="插件智能增强（表格状态徽章、裸 Hash 折叠复制、RGB 色块、本地证据内联速览、GFM 告警）">
                            <span class="set-row-label">Smart enhancements</span>
                            <span class="set-toggle on" data-action="smart-enhancements"></span>
                        </div>
                    </div>
                </div>

                <div id="folio-find-bar" aria-label="Find in preview">
                    <input id="folio-find-input" type="text" placeholder="搜索文档内容…" autocomplete="off" />
                    <span id="folio-find-count"></span>
                    <button id="folio-find-prev" type="button" class="folio-find-btn" title="上一处 (Shift+Enter)">↑</button>
                    <button id="folio-find-next" type="button" class="folio-find-btn" title="下一处 (Enter)">↓</button>
                    <button id="folio-find-close" type="button" class="folio-find-btn" title="关闭 (Esc)">✕</button>
                </div>

                <div class="workspace-shell">
                    <div id="toc-backdrop" class="toc-backdrop"></div>
                    <aside id="sidebar-toc"></aside>
                    <main id="document-container" class="toolbar-collapsed">
                        <div id="document-paper" class="width-standard">
                            <div id="document-content">Loading...</div>
                        </div>
                    </main>
                </div>

                <div id="folio-toast" role="status" aria-live="polite"></div>

                <div id="folio-lightbox" class="folio-lightbox" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Image preview">
                    <div class="folio-lightbox-bar">
                        <div class="folio-lightbox-meta">
                            <span id="folio-lightbox-counter" class="folio-lightbox-counter"></span>
                            <span id="folio-lightbox-title" class="folio-lightbox-title"></span>
                        </div>
                        <div class="folio-lightbox-actions">
                            <button id="folio-lightbox-zoom-toggle" type="button" class="folio-lb-btn" title="切换适应屏幕 / 1:1 原寸 (Space / 0)">1:1</button>
                            <button id="folio-lightbox-open-file" type="button" class="folio-lb-btn" title="在编辑器中打开原图">打开文件</button>
                            <button id="folio-lightbox-close" type="button" class="folio-lb-btn folio-lb-close" title="关闭 (Esc)">✕</button>
                        </div>
                    </div>
                    <button id="folio-lightbox-prev" type="button" class="folio-lb-nav folio-lb-prev" title="上一张 (←)" aria-label="Previous image">‹</button>
                    <div id="folio-lightbox-stage" class="folio-lightbox-stage">
                        <img id="folio-lightbox-img" class="folio-lightbox-img" alt="" />
                        <div id="folio-lightbox-error" class="folio-lightbox-error"></div>
                    </div>
                    <button id="folio-lightbox-next" type="button" class="folio-lb-nav folio-lb-next" title="下一张 (→)" aria-label="Next image">›</button>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
