import { Renderer } from './renderer';
import { Toolbar, applyLineSpacingVars } from './toolbar';
import { Toc } from './toc';
import { ScrollSync } from './scrollSync';
import {
    enhanceInlineCodes,
    enhanceLinksAndImages,
    enhanceSectionsAndTables,
    FindInPage,
    handleResolvedImageDataUri,
    setExpandImageLinksEnabled,
    setInlineCodeCopyEnabled,
    showPreviewToast
} from './interactions';
import './styles/theme.css';
import './styles/document.css';
import './styles/toolbar.css';
import './styles/sidebar.css';

declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const renderer = new Renderer('document-content');
const toolbar = new Toolbar(vscode);
const toc = new Toc('sidebar-toc');
const scrollSync = new ScrollSync(vscode, 'document-container');
const findInPage = new FindInPage();
const codeCopyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="5" y="5" width="10" height="10" rx="2"></rect></svg>';
const codeCopiedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';

type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    run: (options: { nodes?: HTMLElement[]; querySelector?: string }) => Promise<unknown>;
};

let mermaidLoadPromise: Promise<MermaidApi> | null = null;
let currentTableWrapThreshold = 320;
let currentExpandImageLinks = false;

function updateTableOverflowHint(wrapper: HTMLElement) {
    const hasScroll = wrapper.scrollWidth > wrapper.clientWidth + 2;
    const atEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 2;
    wrapper.classList.toggle('has-overflow-right', hasScroll && !atEnd);
}

interface TableMeasurementEntry {
    wrapper: HTMLElement;
    table: HTMLTableElement;
    rows: HTMLTableRowElement[];
    cells: HTMLTableCellElement[];
    inlineCodes: HTMLElement[];
    colCount: number;
    prevTableWidth: string;
    prevCellWs: string[];
    prevCodeWs: string[];
    colMaxNaturalWidths: number[];
    headerNaturalWidths: number[];
}

function enhanceTables(threshold: number = currentTableWrapThreshold) {
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>('#document-content .table-wrapper'));
    if (wrappers.length === 0) { return; }

    const entries: TableMeasurementEntry[] = [];
    for (const wrapper of wrappers) {
        if (wrapper.dataset.overflowBound !== 'true') {
            wrapper.dataset.overflowBound = 'true';
            let wrapperScrollRafId: number | null = null;
            wrapper.addEventListener('scroll', () => {
                if (wrapperScrollRafId !== null) { return; }
                wrapperScrollRafId = window.requestAnimationFrame(() => {
                    wrapperScrollRafId = null;
                    updateTableOverflowHint(wrapper);
                });
            }, { passive: true });
        }

        const table = wrapper.querySelector<HTMLTableElement>('table');
        if (!table) { continue; }

        const rows = Array.from(table.rows);
        // Use direct table rows' cells so nested tables never mix into outer table save/restore
        const cells = rows.flatMap(row => Array.from(row.cells));
        const inlineCodes = Array.from(table.querySelectorAll<HTMLElement>('code'))
            .filter(code => code.closest('table') === table);
        const colCount = rows[0]?.cells.length ?? 0;

        entries.push({
            wrapper,
            table,
            rows,
            cells,
            inlineCodes,
            colCount,
            prevTableWidth: '',
            prevCellWs: [],
            prevCodeWs: [],
            colMaxNaturalWidths: new Array<number>(colCount).fill(0),
            headerNaturalWidths: new Array<number>(colCount).fill(0),
        });
    }

    // Phase 1: Batch reset previous overrides and enter measurement mode across all tables
    for (const entry of entries) {
        for (const cell of entry.cells) {
            cell.classList.remove('table-cell-nowrap', 'table-cell-wrap');
            cell.style.minWidth = '';
            cell.style.maxWidth = '';
        }

        if (threshold > 0 && entry.rows.length > 0) {
            entry.prevTableWidth = entry.table.style.width;
            entry.prevCellWs = entry.cells.map(cell => cell.style.whiteSpace);
            entry.prevCodeWs = entry.inlineCodes.map(code => code.style.whiteSpace);

            entry.table.style.width = 'max-content';
            for (const cell of entry.cells) { cell.style.whiteSpace = 'nowrap'; }
            for (const code of entry.inlineCodes) { code.style.whiteSpace = 'nowrap'; }
        }
    }

    if (threshold > 0) {
        // Phase 2: Read all single-line natural widths in a single layout pass
        for (const entry of entries) {
            if (entry.rows.length === 0) { continue; }
            for (const row of entry.rows) {
                Array.from(row.cells).forEach((cell, colIdx) => {
                    if (colIdx < entry.colCount && cell.colSpan === 1) {
                        const w = cell.offsetWidth;
                        if (cell.tagName === 'TH') {
                            if (w > entry.headerNaturalWidths[colIdx]) {
                                entry.headerNaturalWidths[colIdx] = w;
                            }
                        } else if (w > entry.colMaxNaturalWidths[colIdx]) {
                            entry.colMaxNaturalWidths[colIdx] = w;
                        }
                    }
                });
            }
        }

        // Phase 3: Restore inline styles and apply wrap/nowrap classification across all tables
        for (const entry of entries) {
            if (entry.rows.length === 0) { continue; }
            entry.table.style.width = entry.prevTableWidth;
            entry.cells.forEach((cell, idx) => { cell.style.whiteSpace = entry.prevCellWs[idx]; });
            entry.inlineCodes.forEach((code, idx) => { code.style.whiteSpace = entry.prevCodeWs[idx]; });

            for (let colIdx = 0; colIdx < entry.colCount; colIdx++) {
                const isLongColumn = entry.colMaxNaturalWidths[colIdx] > threshold;
                const headerFitsSingleLine = entry.headerNaturalWidths[colIdx] <= threshold;
                for (const row of entry.rows) {
                    const cell = row.cells[colIdx];
                    if (!cell || cell.colSpan !== 1) { continue; }

                    const shouldWrap = cell.tagName === 'TH' ? !headerFitsSingleLine : isLongColumn;
                    if (shouldWrap) {
                        cell.classList.add('table-cell-wrap');
                        cell.style.minWidth = `${threshold}px`;
                        cell.style.maxWidth = `${Math.round(threshold * 1.35)}px`;
                    } else {
                        cell.classList.add('table-cell-nowrap');
                    }
                }
            }
        }
    }

    // Phase 4: Read all overflow metrics first, then batch-write hint classes
    const overflowStates = wrappers.map(wrapper => {
        const hasScroll = wrapper.scrollWidth > wrapper.clientWidth + 2;
        const atEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 2;
        return hasScroll && !atEnd;
    });
    wrappers.forEach((wrapper, idx) => {
        wrapper.classList.toggle('has-overflow-right', overflowStates[idx]);
    });
}

function syncPaperScaleHeight() {
    const paper = document.getElementById('document-paper');
    const container = document.getElementById('document-container');
    if (!paper) { return; }
    const naturalHeight = paper.offsetHeight;
    if (naturalHeight > 0) {
        paper.style.setProperty('--paper-natural-height', `${naturalHeight}px`);
    }
    if (container) {
        const zoom = parseFloat(document.documentElement.style.getPropertyValue('--zoom-scale') || '1') || 1;
        const scaledWidth = paper.offsetWidth * zoom;
        paper.style.transformOrigin = scaledWidth > container.clientWidth - 32 ? 'top left' : 'top center';
    }
}

function applyReadingProgress(bar: HTMLElement, scrollTop: number, scrollable: number) {
    const ratio = scrollable <= 0 ? 0 : Math.min(1, Math.max(0, scrollTop / scrollable));
    bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
}

let readingProgressRafId: number | null = null;
function updateReadingProgress() {
    if (readingProgressRafId !== null) { return; }
    readingProgressRafId = window.requestAnimationFrame(() => {
        readingProgressRafId = null;
        const container = document.getElementById('document-container');
        const bar = document.getElementById('reading-progress-bar');
        if (!container || !bar) { return; }
        applyReadingProgress(bar, container.scrollTop, container.scrollHeight - container.clientHeight);
    });
}

// Center toolbar over #document-container (not full viewport, to account for TOC sidebar)
function syncToolbarPosition() {
    const container = document.getElementById('document-container');
    const tb = document.getElementById('toolbar');
    if (!container || !tb) { return; }
    const rect = container.getBoundingClientRect();
    const isCollapsed = tb.classList.contains('collapsed') || tb.style.display === 'none';
    container.classList.toggle('toolbar-collapsed', isCollapsed);

    if (tb.classList.contains('collapsed')) {
        // Pin to the right edge of the document container
        tb.style.left = `${rect.right - 20}px`;
        tb.style.transform = 'translateX(-100%)';
    } else {
        tb.style.left = `${rect.left + rect.width / 2}px`;
        tb.style.transform = 'translateX(-50%)';
    }
    toc.syncFabVisibility();
    syncPaperScaleHeight();
}
(window as any).syncToolbarPosition = syncToolbarPosition;

let layoutSyncRafId: number | null = null;
function runViewportLayoutSync() {
    layoutSyncRafId = null;
    const container = document.getElementById('document-container');
    const tb = document.getElementById('toolbar');
    const paper = document.getElementById('document-paper');
    const bar = document.getElementById('reading-progress-bar');
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>('#document-content .table-wrapper'));

    // Read all layout geometry before mutating DOM styles/classes
    const rect = container?.getBoundingClientRect();
    const isCollapsed = tb ? (tb.classList.contains('collapsed') || tb.style.display === 'none') : false;
    const paperHeight = paper?.offsetHeight ?? 0;
    const paperWidth = paper?.offsetWidth ?? 0;
    const zoom = parseFloat(document.documentElement.style.getPropertyValue('--zoom-scale') || '1') || 1;
    const containerWidth = container?.clientWidth ?? 0;
    const scrollable = container ? container.scrollHeight - container.clientHeight : 0;
    const scrollTop = container?.scrollTop ?? 0;
    const overflowStates = wrappers.map(wrapper => {
        const hasScroll = wrapper.scrollWidth > wrapper.clientWidth + 2;
        const atEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 2;
        return hasScroll && !atEnd;
    });

    // Write all style/class updates together
    if (container && tb && rect) {
        container.classList.toggle('toolbar-collapsed', isCollapsed);
        if (tb.classList.contains('collapsed')) {
            tb.style.left = `${rect.right - 20}px`;
            tb.style.transform = 'translateX(-100%)';
        } else {
            tb.style.left = `${rect.left + rect.width / 2}px`;
            tb.style.transform = 'translateX(-50%)';
        }
        toc.syncFabVisibility();
    }
    if (paper) {
        if (paperHeight > 0) {
            paper.style.setProperty('--paper-natural-height', `${paperHeight}px`);
        }
        if (container) {
            const scaledWidth = paperWidth * zoom;
            paper.style.transformOrigin = scaledWidth > containerWidth - 32 ? 'top left' : 'top center';
        }
    }
    if (bar) {
        applyReadingProgress(bar, scrollTop, scrollable);
    }
    wrappers.forEach((wrapper, idx) => {
        wrapper.classList.toggle('has-overflow-right', overflowStates[idx]);
    });
}

function scheduleViewportLayoutSync() {
    if (layoutSyncRafId !== null) { return; }
    layoutSyncRafId = window.requestAnimationFrame(runViewportLayoutSync);
}

const resizeObserver = new ResizeObserver(scheduleViewportLayoutSync);
resizeObserver.observe(document.getElementById('document-container') ?? document.body);
const paperEl = document.getElementById('document-paper');
if (paperEl) {
    resizeObserver.observe(paperEl);
}
document.getElementById('document-container')?.addEventListener('scroll', updateReadingProgress, { passive: true });
document.addEventListener('markdown-folio:zoom-changed', syncPaperScaleHeight);
document.addEventListener('markdown-folio:table-threshold-changed', (event: Event) => {
    const customEvent = event as CustomEvent<{ threshold: number }>;
    if (typeof customEvent.detail?.threshold === 'number') {
        currentTableWrapThreshold = customEvent.detail.threshold;
        enhanceTables(currentTableWrapThreshold);
        syncPaperScaleHeight();
        scrollSync.rebuildIndex();
    }
});
document.addEventListener('markdown-folio:expand-image-links-changed', (event: Event) => {
    const customEvent = event as CustomEvent<{ enabled: boolean }>;
    if (typeof customEvent.detail?.enabled === 'boolean') {
        currentExpandImageLinks = customEvent.detail.enabled;
        setExpandImageLinksEnabled(currentExpandImageLinks, true);
    }
});
window.addEventListener('resize', scheduleViewportLayoutSync);
syncToolbarPosition();

function getMermaidTheme(): 'dark' | 'default' {
    const lightThemes = ['ivory-mode', 'serene-mode', 'github-mode', 'zen-mode'];
    const isLightTheme = lightThemes.some(cls => document.body.classList.contains(cls));
    return isLightTheme ? 'default' : 'dark';
}

function prepareMermaidNodes(nodes: HTMLElement[], restoreSource: boolean): void {
    nodes.forEach(el => {
        if (!el.dataset.mermaidSource) {
            el.dataset.mermaidSource = el.textContent || '';
        }
        if (restoreSource) {
            el.textContent = el.dataset.mermaidSource || '';
        }
        el.removeAttribute('data-processed');
        el.classList.remove('language-mermaid');
        el.classList.add('mermaid');
    });
}

function loadMermaid(): Promise<MermaidApi> {
    if (mermaidLoadPromise) {
        return mermaidLoadPromise;
    }

    const existing = (window as any).mermaid as MermaidApi | undefined;
    if (existing) {
        mermaidLoadPromise = Promise.resolve(existing);
        return mermaidLoadPromise;
    }

    mermaidLoadPromise = new Promise((resolve, reject) => {
        const src = document.body.dataset.mermaidSrc;
        if (!src) {
            reject(new Error('Mermaid script URI is missing'));
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => {
            const api = (window as any).mermaid as MermaidApi | undefined;
            api ? resolve(api) : reject(new Error('Mermaid API is unavailable'));
        };
        script.onerror = () => reject(new Error('Failed to load Mermaid'));
        document.head.appendChild(script);
    });

    return mermaidLoadPromise;
}

async function runMermaid(nodes: HTMLElement[], restoreSource: boolean): Promise<void> {
    if (nodes.length === 0) {
        return;
    }
    prepareMermaidNodes(nodes, restoreSource);
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme(), securityLevel: 'loose' });
    await mermaid.run({ nodes });
}

function getCodeBlockText(pre: HTMLPreElement): string {
    const code = pre.querySelector('code');
    return code?.textContent ?? pre.textContent ?? '';
}

function flashCodeCopyButton(button: HTMLButtonElement) {
    button.innerHTML = codeCopiedIcon;
    button.title = '已复制';
    button.setAttribute('aria-label', '已复制');
    button.classList.add('copied');
    window.setTimeout(() => {
        button.innerHTML = codeCopyIcon;
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
        button.classList.remove('copied');
    }, 1200);
}

function enhanceCodeBlockCopyButtons() {
    document.querySelectorAll<HTMLPreElement>('#document-content pre').forEach(pre => {
        if (pre.dataset.copyEnhanced === 'true') {
            return;
        }
        if (pre.querySelector('code.language-mermaid, code.mermaid')) {
            return;
        }

        pre.dataset.copyEnhanced = 'true';
        pre.classList.add('has-code-header');

        const codeEl = pre.querySelector('code');
        const langMatch = codeEl?.className.match(/\blanguage-([a-zA-Z0-9_+-]+)/);
        const langName = langMatch ? langMatch[1] : 'code';

        const header = document.createElement('div');
        header.className = 'code-block-header';
        header.setAttribute('data-lang', langName);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'code-copy-btn';
        button.innerHTML = codeCopyIcon;
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();

            const text = getCodeBlockText(pre);
            try {
                await navigator.clipboard.writeText(text);
                flashCodeCopyButton(button);
            } catch {
                vscode.postMessage({ type: 'copy', payload: { mode: 'plain-text-fallback', text } });
                flashCodeCopyButton(button);
            }
        });

        header.appendChild(button);
        pre.insertBefore(header, pre.firstChild);
    });
}

// Handle messages from the extension host
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'render': {
            const { config } = message.payload;
            if (config) {
                applySettings(config);
                toolbar.syncFromSettings(config);
                scrollSync.setEnabled(config.scrollSync !== false);
            }
            renderer.render(message.payload.html);
            enhanceCodeBlockCopyButtons();
            enhanceTables(currentTableWrapThreshold);
            enhanceInlineCodes(vscode);
            enhanceSectionsAndTables(vscode);
            enhanceLinksAndImages(vscode, () => {
                syncPaperScaleHeight();
                scrollSync.rebuildIndex();
            });
            toc.render(message.payload.toc);
            findInPage.refresh();

            // Build scroll index immediately so sync works for non-mermaid content
            scrollSync.rebuildIndex();
            syncPaperScaleHeight();
            updateReadingProgress();

            // Re-sync toolbar after TOC sidebar show/hide changes layout
            setTimeout(syncToolbarPosition, 50);

            // Render only newly added or modified mermaid diagrams (unchanged ones were restored from SVG cache)
            const mermaidCodes = document.querySelectorAll<HTMLElement>('.language-mermaid');
            if (mermaidCodes.length > 0) {
                const nodes = Array.from(mermaidCodes);
                // Rebuild index again after Mermaid finishes (async DOM changes shift positions)
                runMermaid(nodes, false)
                    .then(() => {
                        syncPaperScaleHeight();
                        scrollSync.rebuildIndex();
                    })
                    .catch(() => {
                        syncPaperScaleHeight();
                        scrollSync.rebuildIndex();
                    });
            }
            break;
        }
        case 'settings-updated': {
            const getActiveThemeClass = () =>
                Array.from(document.body.classList).find(cls => cls.endsWith('-mode')) ?? '';
            const oldTheme = getActiveThemeClass();
            const prevThreshold = currentTableWrapThreshold;
            applySettings(message.payload);
            toolbar.syncFromSettings(message.payload);
            const themeChanged = oldTheme !== getActiveThemeClass();
            if (message.payload.scrollSync !== undefined) {
                scrollSync.setEnabled(message.payload.scrollSync !== false);
            }
            if (
                currentTableWrapThreshold !== prevThreshold ||
                message.payload.fontSize !== undefined ||
                message.payload.headingSize !== undefined ||
                message.payload.lineSpacing !== undefined ||
                message.payload.bodyFont !== undefined ||
                message.payload.pageWidth !== undefined ||
                themeChanged
            ) {
                enhanceTables(currentTableWrapThreshold);
                syncPaperScaleHeight();
                scrollSync.rebuildIndex();
            }
            setTimeout(syncToolbarPosition, 50);
            
            // Re-render mermaid if theme actually changed
            if (themeChanged) {
                const mermaidCodes = document.querySelectorAll<HTMLElement>('.mermaid');
                if (mermaidCodes.length > 0) {
                    const nodes = Array.from(mermaidCodes);
                    runMermaid(nodes, true)
                        .then(() => scrollSync.rebuildIndex())
                        .catch(() => scrollSync.rebuildIndex());
                }
            }
            break;
        }
        case 'scroll-to-line': {
            scrollSync.handleMessage(message);
            break;
        }
        case 'toast': {
            showPreviewToast(message.payload?.message ?? '', message.payload?.tone);
            break;
        }
        case 'image-data-uri-resolved': {
            handleResolvedImageDataUri(message.payload ?? {});
            break;
        }
    }
});

function applySettings(settings: {
    headingFont?: string;
    bodyFont?: string;
    fontSize?: number;
    headingSize?: 'S' | 'M' | 'L';
    lineSpacing?: string;
    pageWidth?: string;
    showToolbar?: boolean;
    showTocSidebar?: boolean;
    theme?: 'admiral' | 'ivory' | 'serene' | 'cyberpunk' | 'dracula' | 'github' | 'zen';
    scrollSync?: boolean;
    tableWrapThreshold?: number;
    clickInlineCodeCopy?: boolean;
    expandImageLinks?: boolean;
}) {
    const root = document.documentElement;
    const defaultHeadingFont = "'Merriweather', Georgia, serif";
    const defaultBodyFont = "'DM Sans', 'Segoe UI', system-ui, sans-serif";
    if (typeof settings.tableWrapThreshold === 'number') {
        currentTableWrapThreshold = settings.tableWrapThreshold;
    }
    if (settings.clickInlineCodeCopy !== undefined) {
        setInlineCodeCopyEnabled(settings.clickInlineCodeCopy);
    }
    if (settings.expandImageLinks !== undefined) {
        const changed = currentExpandImageLinks !== settings.expandImageLinks;
        currentExpandImageLinks = settings.expandImageLinks;
        setExpandImageLinksEnabled(currentExpandImageLinks, changed);
    }
    if (settings.headingFont) {
        root.style.setProperty('--font-heading', settings.headingFont);
        if (settings.headingFont !== defaultHeadingFont) {
            root.style.setProperty('--custom-font-heading', settings.headingFont);
        } else {
            root.style.removeProperty('--custom-font-heading');
        }
    }
    if (settings.bodyFont) {
        root.style.setProperty('--font-body', settings.bodyFont);
        if (settings.bodyFont !== defaultBodyFont) {
            root.style.setProperty('--custom-font-body', settings.bodyFont);
        } else {
            root.style.removeProperty('--custom-font-body');
        }
    }
    if (settings.fontSize) { root.style.setProperty('--font-size-body', `${settings.fontSize}px`); }
    if (settings.headingSize) {
        const scaleMap: Record<string, string> = { S: '0.8', M: '1', L: '1.25' };
        root.style.setProperty('--heading-scale', scaleMap[settings.headingSize] ?? '1');
    }
    if (settings.lineSpacing) {
        applyLineSpacingVars(settings.lineSpacing, root);
    }
    if (settings.pageWidth) {
        const paper = document.getElementById('document-paper');
        if (paper) {
            paper.className = paper.className.replace(/width-\w+/g, '').trim();
            paper.classList.add(`width-${settings.pageWidth}`);
        }
        document.body.classList.toggle('page-width-full', settings.pageWidth === 'full');
    }
    if (settings.showToolbar !== undefined) {
        const tb = document.getElementById('toolbar');
        const container = document.getElementById('document-container');
        if (tb) {
            tb.style.display = settings.showToolbar ? '' : 'none';
        }
        if (container) {
            const isCollapsed = !settings.showToolbar || Boolean(tb?.classList.contains('collapsed'));
            container.classList.toggle('toolbar-collapsed', isCollapsed);
        }
    }
    if (settings.showTocSidebar !== undefined) {
        const sidebar = document.getElementById('sidebar-toc');
        if (sidebar) {
            sidebar.style.display = settings.showTocSidebar ? '' : 'none';
            if (!settings.showTocSidebar) {
                sidebar.classList.remove('drawer-open');
                document.getElementById('toc-backdrop')?.classList.remove('show');
            }
        }
        toc.syncFabVisibility();
    }
    if (settings.theme !== undefined) {
        document.body.classList.remove('ivory-mode', 'admiral-mode', 'serene-mode', 'cyberpunk-mode', 'dracula-mode', 'github-mode', 'zen-mode');
        
        if (settings.theme === 'ivory') {
            document.body.classList.add('ivory-mode');
        } else if (settings.theme === 'admiral') {
            document.body.classList.add('admiral-mode');
        } else if (settings.theme === 'serene') {
            document.body.classList.add('serene-mode');
        } else if (settings.theme === 'cyberpunk') {
            document.body.classList.add('cyberpunk-mode');
        } else if (settings.theme === 'dracula') {
            document.body.classList.add('dracula-mode');
        } else if (settings.theme === 'github') {
            document.body.classList.add('github-mode');
        } else if (settings.theme === 'zen') {
            document.body.classList.add('zen-mode');
        }
        
        // Update active state in theme dropdown
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', (btn as HTMLElement).dataset.theme === settings.theme);
        });
    }
}

// Signal to extension that webview is ready to receive messages
vscode.postMessage({ type: 'ready' });
