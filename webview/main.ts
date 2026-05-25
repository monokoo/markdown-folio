import { Renderer } from './renderer';
import { Toolbar } from './toolbar';
import { Toc } from './toc';
import { ScrollSync } from './scrollSync';
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
const codeCopyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="5" y="5" width="10" height="10" rx="2"></rect></svg>';
const codeCopiedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';

type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    run: (options: { nodes?: HTMLElement[]; querySelector?: string }) => Promise<unknown>;
};

let mermaidLoadPromise: Promise<MermaidApi> | null = null;

// Center toolbar over #document-container (not full viewport, to account for TOC sidebar)
function syncToolbarPosition() {
    const container = document.getElementById('document-container');
    const tb = document.getElementById('toolbar');
    if (!container || !tb) { return; }
    const rect = container.getBoundingClientRect();
    
    if (tb.classList.contains('collapsed')) {
        // Pin to the right edge of the document container
        tb.style.left = `${rect.right - 24}px`;
        tb.style.transform = 'translateX(-100%)';
    } else {
        tb.style.left = `${rect.left + rect.width / 2}px`;
        tb.style.transform = 'translateX(-50%)';
    }
}
(window as any).syncToolbarPosition = syncToolbarPosition;

const resizeObserver = new ResizeObserver(syncToolbarPosition);
resizeObserver.observe(document.getElementById('document-container') ?? document.body);
window.addEventListener('resize', syncToolbarPosition);
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
        if (pre.querySelector('code.language-mermaid')) {
            return;
        }

        pre.dataset.copyEnhanced = 'true';
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
        pre.appendChild(button);
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
            toc.render(message.payload.toc);

            // Build scroll index immediately so sync works for non-mermaid content
            scrollSync.rebuildIndex();

            // Re-sync toolbar after TOC sidebar show/hide changes layout
            setTimeout(syncToolbarPosition, 50);

            // Render mermaid
            const mermaidCodes = document.querySelectorAll<HTMLElement>('.language-mermaid');
            if (mermaidCodes.length > 0) {
                const nodes = Array.from(mermaidCodes);
                // Rebuild index again after Mermaid finishes (async DOM changes shift positions)
                runMermaid(nodes, false)
                    .then(() => scrollSync.rebuildIndex())
                    .catch(() => scrollSync.rebuildIndex()); // Re-index even on failure (fallback <pre> still has anchor)
            }
            break;
        }
        case 'settings-updated': {
            const oldTheme = document.body.className;
            applySettings(message.payload);
            toolbar.syncFromSettings(message.payload);
            if (message.payload.scrollSync !== undefined) {
                scrollSync.setEnabled(message.payload.scrollSync !== false);
            }
            setTimeout(syncToolbarPosition, 50);
            
            // Re-render mermaid if theme actually changed
            if (oldTheme !== document.body.className) {
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
}) {
    const root = document.documentElement;
    if (settings.headingFont) { root.style.setProperty('--font-heading', settings.headingFont); }
    if (settings.bodyFont) { root.style.setProperty('--font-body', settings.bodyFont); }
    if (settings.fontSize) { root.style.setProperty('--font-size-body', `${settings.fontSize}px`); }
    if (settings.headingSize) {
        const scaleMap: Record<string, string> = { S: '0.8', M: '1', L: '1.25' };
        root.style.setProperty('--heading-scale', scaleMap[settings.headingSize] ?? '1');
    }
    if (settings.lineSpacing) {
        const lineHeightMap: Record<string, string> = { compact: '1.5', normal: '1.72', relaxed: '2.0' };
        root.style.setProperty('--line-height-body', lineHeightMap[settings.lineSpacing] ?? '1.72');
    }
    if (settings.pageWidth) {
        const paper = document.getElementById('document-paper');
        if (paper) {
            paper.className = paper.className.replace(/width-\w+/g, '').trim();
            paper.classList.add(`width-${settings.pageWidth}`);
        }
    }
    if (settings.showToolbar !== undefined) {
        const tb = document.getElementById('toolbar');
        const container = document.getElementById('document-container');
        if (tb) {
            tb.style.display = settings.showToolbar ? '' : 'none';
        }
        if (container) {
            container.style.paddingTop = settings.showToolbar ? '' : '32px';
        }
    }
    if (settings.showTocSidebar !== undefined) {
        const sidebar = document.getElementById('sidebar-toc');
        if (sidebar) {
            sidebar.style.display = settings.showTocSidebar ? '' : 'none';
        }
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
