type TokenCategory =
    | '路径'
    | '命令'
    | 'ID'
    | 'Pod IP'
    | 'Commit'
    | '配置/类名'
    | '标识'
    | 'ignore';

interface ClassifiedToken {
    copyable: boolean;
    isPath: boolean;
    isAccent: boolean;
    category: TokenCategory;
}

const FILE_EXT_RE =
    /\.(json|py|md|mdx|ts|tsx|js|jsx|mjs|cjs|css|scss|html|htm|yml|yaml|toml|properties|xml|sh|zsh|bash|sql|log|txt|csv|java|kt|go|rs|vue|svelte|env|conf|ini|lock)(?::\d+(?::\d+)?)?$/i;
const COMMAND_RE = /^(python3?|npm|npx|pnpm|yarn|git|node|docker|kubectl|curl|bash|sh|rg|pytest|java|mvn|gradle)\s+/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/;
const HEX_HASH_RE = /^[0-9a-f]{12,64}$/i;
const DOTTED_SYMBOL_RE = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_$-]+){2,}$/;
const NUMERIC_ID_RE = /^\d{5,}$/;
const NUMERIC_GROUP_RE = /^\d{4,}(?:\s*\/\s*\d{4,})+$/;
const PREFIX_IDENT_RE = /^(?:[A-Z]{2,}(?:_[A-Z0-9]+)+|TR\d+-|c-t\d+-|feature-|release-|hotfix-)/;
const ACCENT_NUMBER_RE = /^(?:\d+(?:\.\d+)?|\d+(?:\s*(?:→|\/|-)\s*\d+)+|\[\d+(?:\s*,\s*\d+)*\])$/;
const ACCENT_ENUM_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ACCENT_KV_RE = /^[a-zA-Z0-9_.-]+=[a-zA-Z0-9_.-]+$/;
const ACCENT_STATUS_RE = /^(?:confirm|passed_confirmed|failed|success|error|timeout)$/;

function isAccentToken(trimmed: string): boolean {
    return (
        ACCENT_NUMBER_RE.test(trimmed) ||
        IPV4_RE.test(trimmed) ||
        ACCENT_ENUM_RE.test(trimmed) ||
        ACCENT_KV_RE.test(trimmed) ||
        ACCENT_STATUS_RE.test(trimmed)
    );
}

export function classifyInlineCode(raw: string): ClassifiedToken {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { copyable: false, isPath: false, isAccent: false, category: 'ignore' };
    }

    const hasSpace = /\s/.test(trimmed);
    const looksNumericRatio = /^\d+(?:\s*[/.]\s*\d+)*$/.test(trimmed);

    if (!hasSpace && !looksNumericRatio && !trimmed.includes('(') && !trimmed.includes('→')) {
        if ((trimmed.includes('/') && !trimmed.startsWith('http')) || FILE_EXT_RE.test(trimmed)) {
            return { copyable: true, isPath: true, isAccent: false, category: '路径' };
        }
    }

    const accent = isAccentToken(trimmed);

    if (COMMAND_RE.test(trimmed)) {
        return { copyable: true, isPath: false, isAccent: false, category: '命令' };
    }
    if (IPV4_RE.test(trimmed)) {
        return { copyable: true, isPath: false, isAccent: true, category: 'Pod IP' };
    }
    if (HEX_HASH_RE.test(trimmed)) {
        return { copyable: true, isPath: false, isAccent: false, category: 'Commit' };
    }
    if (NUMERIC_ID_RE.test(trimmed) || NUMERIC_GROUP_RE.test(trimmed)) {
        return { copyable: true, isPath: false, isAccent: true, category: 'ID' };
    }
    if (DOTTED_SYMBOL_RE.test(trimmed) || trimmed.includes('→')) {
        return { copyable: true, isPath: false, isAccent: false, category: '配置/类名' };
    }
    if (PREFIX_IDENT_RE.test(trimmed) || (trimmed.includes('=') && trimmed.length >= 6) || trimmed.length >= 12) {
        return { copyable: true, isPath: false, isAccent: accent, category: '标识' };
    }

    return { copyable: false, isPath: false, isAccent: accent, category: 'ignore' };
}

let toastTimer: number | null = null;
export function showPreviewToast(message: string, tone: 'info' | 'warn' = 'info'): void {
    const el = document.getElementById('folio-toast');
    if (!el) { return; }
    el.textContent = message;
    el.classList.toggle('is-warn', tone === 'warn');
    el.classList.add('show');
    if (toastTimer !== null) {
        window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
        el.classList.remove('show');
        toastTimer = null;
    }, 1800);
}

async function copyTextWithFallback(vscode: any, text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        vscode.postMessage({ type: 'copy', payload: { mode: 'plain-text-fallback', text } });
    }
}

export function tableToMarkdown(table: HTMLTableElement): string {
    const rows = Array.from(table.querySelectorAll('tr'));
    return rows
        .map((tr, rIdx) => {
            const cells = Array.from(tr.children).map(cell =>
                (cell.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')
            );
            const line = `| ${cells.join(' | ')} |`;
            if (rIdx !== 0) {
                return line;
            }
            const sep = Array.from(tr.children)
                .map(cell => {
                    const align = (cell.getAttribute('align') || '').toLowerCase();
                    if (align === 'right') { return '---:'; }
                    if (align === 'center') { return ':---:'; }
                    return '---';
                })
                .join(' | ');
            return `${line}\n| ${sep} |`;
        })
        .join('\n');
}

export function tableToTsv(table: HTMLTableElement): string {
    return Array.from(table.querySelectorAll('tr'))
        .map(tr =>
            Array.from(tr.children)
                .map(cell => (cell.textContent ?? '').trim().replace(/\s+/g, ' '))
                .join('\t')
        )
        .join('\n');
}

function getHeadingCleanText(heading: HTMLElement): string {
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.folio-heading-tools').forEach(node => node.remove());
    return (clone.textContent ?? '').trim();
}

function extractSectionText(heading: HTMLElement): string {
    const level = parseInt(heading.tagName.slice(1), 10) || 2;
    const prefix = '#'.repeat(level);
    const parts: string[] = [`${prefix} ${getHeadingCleanText(heading)}`];
    let cur = heading.nextElementSibling;
    while (cur) {
        if (/^H[1-6]$/.test(cur.tagName)) {
            const nextLevel = parseInt(cur.tagName.slice(1), 10);
            if (nextLevel <= level) { break; }
        }
        if (cur.classList.contains('table-wrapper')) {
            const table = cur.querySelector('table');
            if (table) {
                parts.push(tableToMarkdown(table));
            }
        } else if (cur.tagName === 'PRE') {
            const clone = cur.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('.code-block-header').forEach(node => node.remove());
            parts.push('```\n' + (clone.textContent ?? '').trim() + '\n```');
        } else if (cur.tagName === 'UL' || cur.tagName === 'OL') {
            const isOrdered = cur.tagName === 'OL';
            const items = Array.from(cur.querySelectorAll(':scope > li')).map((li, i) =>
                `${isOrdered ? `${i + 1}.` : '-'} ${(li.textContent ?? '').trim()}`
            );
            if (items.length > 0) {
                parts.push(items.join('\n'));
            }
        } else if (/^H[1-6]$/.test(cur.tagName)) {
            const subLevel = parseInt(cur.tagName.slice(1), 10);
            parts.push(`${'#'.repeat(subLevel)} ${getHeadingCleanText(cur as HTMLElement)}`);
        } else {
            const text = (cur.textContent ?? '').trim();
            if (text) {
                parts.push(text);
            }
        }
        cur = cur.nextElementSibling;
    }
    return parts.join('\n\n');
}

let inlineCodeCopyEnabled = true;

function updateInlineCodeTitle(el: HTMLElement, category: TokenCategory): void {
    const isPath = el.classList.contains('folio-path-code');
    if (inlineCodeCopyEnabled) {
        el.title = isPath ? '单击复制路径 · Alt+单击 在编辑器打开' : `单击复制 (${category})`;
    } else {
        el.title = isPath ? 'Alt+单击 在编辑器打开' : '';
    }
}

export function setInlineCodeCopyEnabled(enabled: boolean): void {
    inlineCodeCopyEnabled = enabled;
    document.body.classList.toggle('inline-code-copy-enabled', enabled);
    document.querySelectorAll<HTMLElement>('#document-content code.folio-copyable-code').forEach(el => {
        const category = (el.dataset.tokenCategory as TokenCategory | undefined) ?? '标识';
        updateInlineCodeTitle(el, category);
    });
}

document.addEventListener('markdown-folio:inline-copy-changed', (event: Event) => {
    const customEvent = event as CustomEvent<{ enabled?: boolean }>;
    if (typeof customEvent.detail?.enabled === 'boolean') {
        setInlineCodeCopyEnabled(customEvent.detail.enabled);
    }
});

let inlineCopyDelegated = false;
let latestInlineCopyVscode: any = null;
let inlineDownX = 0;
let inlineDownY = 0;

function ensureInlineCodeDelegation(): void {
    if (inlineCopyDelegated) { return; }
    const contentEl = document.getElementById('document-content');
    if (!contentEl) { return; }
    inlineCopyDelegated = true;

    contentEl.addEventListener('mousedown', (event: MouseEvent) => {
        const target = (event.target as Element | null)?.closest('code.folio-copyable-code');
        if (!target) { return; }
        inlineDownX = event.clientX;
        inlineDownY = event.clientY;
    });

    contentEl.addEventListener('click', async (event: MouseEvent) => {
        const el = (event.target as Element | null)?.closest('code.folio-copyable-code') as HTMLElement | null;
        if (!el) { return; }

        const moved = Math.hypot(event.clientX - inlineDownX, event.clientY - inlineDownY);
        const selected = window.getSelection()?.toString().trim() ?? '';
        if (moved > 5 || selected.length > 0) {
            return;
        }

        const codeText = el.dataset.rawCode ?? (el.textContent ?? '').trim();
        if (el.classList.contains('folio-path-code') && event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            latestInlineCopyVscode?.postMessage({ type: 'open-workspace-file', payload: { path: codeText } });
            return;
        }

        if (!inlineCodeCopyEnabled) {
            return;
        }

        event.stopPropagation();
        await copyTextWithFallback(latestInlineCopyVscode, codeText);
        el.classList.add('folio-inline-copied');
        window.setTimeout(() => el.classList.remove('folio-inline-copied'), 900);
        const category = (el.dataset.tokenCategory as TokenCategory | undefined) ?? '标识';
        const preview = codeText.length > 48 ? `${codeText.slice(0, 48)}…` : codeText;
        showPreviewToast(`已复制 [${category}]：${preview}`);
    });
}

export function enhanceInlineCodes(vscode: any): void {
    latestInlineCopyVscode = vscode;
    ensureInlineCodeDelegation();
    document.body.classList.toggle('inline-code-copy-enabled', inlineCodeCopyEnabled);
    const nodes = document.querySelectorAll<HTMLElement>('#document-content code:not(pre code)');
    nodes.forEach(el => {
        if (el.dataset.inlineEnhanced === 'true') { return; }
        if (el.closest('.katex, .folio-heading-tools, .folio-table-tools')) { return; }

        const raw = (el.textContent ?? '').trim();
        const info = classifyInlineCode(raw);
        el.dataset.inlineEnhanced = 'true';
        if (info.isPath) {
            el.classList.add('folio-path-code');
        } else if (info.isAccent) {
            el.classList.add('folio-accent-code');
        }
        if (!info.copyable) { return; }

        el.dataset.rawCode = raw;
        el.dataset.tokenCategory = info.category;
        el.classList.add('folio-copyable-code');
        updateInlineCodeTitle(el, info.category);
    });
}

export function enhanceSectionsAndTables(vscode: any): void {
    document.querySelectorAll<HTMLElement>('#document-content h2, #document-content h3').forEach(heading => {
        if (heading.dataset.secEnhanced === 'true') { return; }
        heading.dataset.secEnhanced = 'true';

        const tools = document.createElement('span');
        tools.className = 'folio-heading-tools';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'folio-mini-btn';
        btn.textContent = '复制本节';
        btn.title = '复制该章节 Markdown/文本';
        btn.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const text = extractSectionText(heading);
            await copyTextWithFallback(vscode, text);
            btn.textContent = '已复制';
            window.setTimeout(() => { btn.textContent = '复制本节'; }, 1100);
            showPreviewToast('已复制章节内容');
        });

        tools.appendChild(btn);
        heading.appendChild(tools);
    });

    document.querySelectorAll<HTMLElement>('#document-content .table-wrapper').forEach(wrapper => {
        if (wrapper.dataset.tableCopyEnhanced === 'true') { return; }
        const table = wrapper.querySelector<HTMLTableElement>('table');
        if (!table) { return; }
        wrapper.dataset.tableCopyEnhanced = 'true';

        const bar = document.createElement('div');
        bar.className = 'folio-table-tools';

        const btnMd = document.createElement('button');
        btnMd.type = 'button';
        btnMd.className = 'folio-mini-btn';
        btnMd.textContent = '复制 MD';
        btnMd.title = '复制为 Markdown 表格';

        const btnTsv = document.createElement('button');
        btnTsv.type = 'button';
        btnTsv.className = 'folio-mini-btn';
        btnTsv.textContent = '复制表格';
        btnTsv.title = '复制为 TSV（可直接粘贴至飞书/Excel）';

        btnMd.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            await copyTextWithFallback(vscode, tableToMarkdown(table));
            btnMd.textContent = '已复制';
            window.setTimeout(() => { btnMd.textContent = '复制 MD'; }, 1100);
            showPreviewToast('已复制 Markdown 表格');
        });

        btnTsv.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            await copyTextWithFallback(vscode, tableToTsv(table));
            btnTsv.textContent = '已复制';
            window.setTimeout(() => { btnTsv.textContent = '复制表格'; }, 1100);
            showPreviewToast('已复制表格内容（可贴飞书/Excel）');
        });

        bar.appendChild(btnMd);
        bar.appendChild(btnTsv);
        wrapper.insertBefore(bar, wrapper.firstChild);
    });
}

export class FindInPage {
    private static readonly MAX_HIGHLIGHT_MARKS = 500;
    private _bar: HTMLElement | null;
    private _input: HTMLInputElement | null;
    private _countEl: HTMLElement | null;
    private _matches: HTMLElement[] = [];
    private _currentIndex = -1;
    private _totalMatches = 0;
    private _searchTimer: number | null = null;

    constructor() {
        this._bar = document.getElementById('folio-find-bar');
        this._input = document.getElementById('folio-find-input') as HTMLInputElement | null;
        this._countEl = document.getElementById('folio-find-count');
        this._bindEvents();
    }

    private _scheduleSearch(rawQuery: string): void {
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
        }
        this._searchTimer = window.setTimeout(() => {
            this._searchTimer = null;
            this.search(rawQuery);
        }, 90);
    }

    private _flushScheduledSearch(): boolean {
        if (this._searchTimer === null) { return false; }
        window.clearTimeout(this._searchTimer);
        this._searchTimer = null;
        this.search(this._input?.value ?? '');
        return true;
    }

    private _bindEvents(): void {
        document.getElementById('toolbar-find-btn')?.addEventListener('click', event => {
            event.stopPropagation();
            if (this.isOpen()) {
                this.close();
            } else {
                this.open();
            }
        });

        this._input?.addEventListener('input', () => {
            this._scheduleSearch(this._input?.value ?? '');
        });

        this._input?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                if (!this._flushScheduledSearch()) {
                    this.step(event.shiftKey ? -1 : 1);
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
            }
        });

        document.getElementById('folio-find-prev')?.addEventListener('click', () => {
            this._flushScheduledSearch();
            this.step(-1);
        });
        document.getElementById('folio-find-next')?.addEventListener('click', () => {
            this._flushScheduledSearch();
            this.step(1);
        });
        document.getElementById('folio-find-close')?.addEventListener('click', () => this.close());

        document.addEventListener('keydown', event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                this.open();
            } else if (event.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });
    }

    public isOpen(): boolean {
        return Boolean(this._bar?.classList.contains('show'));
    }

    public open(): void {
        if (!this._bar || !this._input) { return; }
        this._bar.classList.add('show');
        const selection = window.getSelection()?.toString().trim();
        if (selection && !selection.includes('\n') && selection.length <= 64) {
            this._input.value = selection;
        }
        this._input.focus();
        this._input.select();
        if (this._input.value.trim()) {
            if (this._searchTimer !== null) {
                window.clearTimeout(this._searchTimer);
                this._searchTimer = null;
            }
            this.search(this._input.value);
        }
    }

    public close(): void {
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        this._bar?.classList.remove('show');
        this.clearHighlights();
    }

    public refresh(): void {
        if (!this.isOpen()) { return; }
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        this.search(this._input?.value ?? '');
    }

    public clearHighlights(): void {
        const root = document.getElementById('document-content');
        if (root) {
            const parentsToNormalize = new Set<Node>();
            root.querySelectorAll('mark.folio-find-mark').forEach(mark => {
                const parent = mark.parentNode;
                if (!parent) { return; }
                parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
                parentsToNormalize.add(parent);
            });
            parentsToNormalize.forEach(parent => parent.normalize());
        }
        this._matches = [];
        this._currentIndex = -1;
        this._totalMatches = 0;
        if (this._countEl) {
            this._countEl.textContent = '';
        }
    }

    public search(rawQuery: string): void {
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        this.clearHighlights();
        const root = document.getElementById('document-content');
        const query = rawQuery.trim();
        if (!root || !query) { return; }

        const lowerQuery = query.toLowerCase();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) { return NodeFilter.FILTER_REJECT; }
                if (parent.closest('.folio-heading-tools, .folio-table-tools, .folio-image-expand-btn, .folio-link-gallery, .code-block-header, .katex-mathml, script, style')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return (node.nodeValue ?? '').toLowerCase().includes(lowerQuery)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            }
        });

        const textNodes: Text[] = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode as Text);
        }

        let totalMatches = 0;
        for (const node of textNodes) {
            const text = node.nodeValue ?? '';
            const lowerText = text.toLowerCase();
            let idx = lowerText.indexOf(lowerQuery, 0);
            if (idx === -1) { continue; }

            if (this._matches.length >= FindInPage.MAX_HIGHLIGHT_MARKS) {
                while (idx !== -1) {
                    totalMatches++;
                    idx = lowerText.indexOf(lowerQuery, idx + query.length);
                }
                continue;
            }

            const frag = document.createDocumentFragment();
            let cursor = 0;
            while (idx !== -1) {
                totalMatches++;
                if (this._matches.length < FindInPage.MAX_HIGHLIGHT_MARKS) {
                    if (idx > cursor) {
                        frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
                    }
                    const mark = document.createElement('mark');
                    mark.className = 'folio-find-mark';
                    mark.textContent = text.slice(idx, idx + query.length);
                    frag.appendChild(mark);
                    this._matches.push(mark);
                    cursor = idx + query.length;
                }
                idx = lowerText.indexOf(lowerQuery, idx + query.length);
            }
            if (cursor < text.length) {
                frag.appendChild(document.createTextNode(text.slice(cursor)));
            }
            node.parentNode?.replaceChild(frag, node);
        }

        this._totalMatches = totalMatches;
        if (this._matches.length > 0) {
            this._activateMatch(0);
        } else if (this._countEl) {
            this._countEl.textContent = '0 / 0';
        }
    }

    public step(delta: number): void {
        if (this._matches.length === 0) { return; }
        const next = (this._currentIndex + delta + this._matches.length) % this._matches.length;
        this._activateMatch(next);
    }

    private _activateMatch(index: number): void {
        if (this._currentIndex >= 0 && this._currentIndex < this._matches.length) {
            this._matches[this._currentIndex].classList.remove('is-current');
        }
        this._currentIndex = index;
        const cur = this._matches[index];
        cur.classList.add('is-current');
        cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (this._countEl) {
            const extra = this._totalMatches > this._matches.length ? ` (共${this._totalMatches})` : '';
            this._countEl.textContent = `${index + 1} / ${this._matches.length}${extra}`;
        }
    }
}

// ─── Image Link Preview, Inline Thumbnail Expansion & Lightbox ────────────────

const IMAGE_LINK_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const EXPAND_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-4 4-2-2-7 7"/></svg>';

interface LightboxItem {
    key: string;
    src: string;
    rawHref?: string;
    title: string;
}

let latestLinkVscode: any = null;
let linkDelegationBound = false;
let linkDownX = 0;
let linkDownY = 0;
let globalExpandImageLinks = false;
let onLinkLayoutChanged: (() => void) | undefined;
const perLinkExpandOverrides = new Map<string, boolean>();
const resolvedDataUriCache = new Map<string, string | null>();
const pendingDataUriRequests = new Map<string, (dataUri: string | null) => void>();
let imageResolveSeq = 0;

function stripQueryAndHash(raw: string): string {
    return raw.split('#')[0].split('?')[0];
}

function safeDecodeHref(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function isExternalHref(rawHref: string): boolean {
    const lower = rawHref.trim().toLowerCase();
    return lower.startsWith('http://')
        || lower.startsWith('https://')
        || lower.startsWith('mailto:')
        || lower.startsWith('vscode:');
}

function isImageHref(rawHref: string): boolean {
    const trimmed = rawHref.trim();
    if (!trimmed || trimmed.startsWith('#') || isExternalHref(trimmed) || trimmed.toLowerCase().startsWith('data:')) {
        return false;
    }
    return IMAGE_LINK_EXT_RE.test(stripQueryAndHash(trimmed));
}

function getLinkBasename(rawHref: string): string {
    const clean = safeDecodeHref(stripQueryAndHash(rawHref));
    const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function isLinkExpanded(key: string): boolean {
    const override = perLinkExpandOverrides.get(key);
    return override !== undefined ? override : globalExpandImageLinks;
}

function requestImageSrc(rawHref: string, preloadedSrc?: string): Promise<string | null> {
    if (preloadedSrc) {
        return Promise.resolve(preloadedSrc);
    }
    if (resolvedDataUriCache.has(rawHref)) {
        return Promise.resolve(resolvedDataUriCache.get(rawHref) ?? null);
    }
    if (!latestLinkVscode) {
        return Promise.resolve(null);
    }

    const requestId = `img-${++imageResolveSeq}`;
    return new Promise(resolve => {
        const timer = window.setTimeout(() => {
            if (pendingDataUriRequests.has(requestId)) {
                pendingDataUriRequests.delete(requestId);
                resolve(null);
            }
        }, 8000);
        pendingDataUriRequests.set(requestId, (dataUri: string | null) => {
            window.clearTimeout(timer);
            resolvedDataUriCache.set(rawHref, dataUri);
            resolve(dataUri);
        });
        latestLinkVscode.postMessage({
            type: 'resolve-image-data-uri',
            payload: { requestId, path: rawHref }
        });
    });
}

export function handleResolvedImageDataUri(payload: { requestId?: string; dataUri?: string | null }): void {
    const requestId = payload?.requestId;
    if (!requestId) { return; }
    const callback = pendingDataUriRequests.get(requestId);
    if (!callback) { return; }
    pendingDataUriRequests.delete(requestId);
    callback(payload.dataUri ?? null);
}

export function setExpandImageLinksEnabled(enabled: boolean, clearOverrides = true): void {
    globalExpandImageLinks = enabled;
    if (clearOverrides) {
        perLinkExpandOverrides.clear();
    }
    const anchors = document.querySelectorAll<HTMLAnchorElement>('#document-content a.folio-image-link');
    anchors.forEach(anchor => syncSingleImageLinkExpansion(anchor));
    onLinkLayoutChanged?.();
}

function findBlockForImageLink(anchor: HTMLAnchorElement): HTMLElement | null {
    return anchor.closest<HTMLElement>('li, p, td, th, blockquote') ?? anchor.parentElement;
}

function ensureGalleryContainer(block: HTMLElement): HTMLElement {
    const children = Array.from(block.children);
    const existing = children.find(el => el.classList.contains('folio-link-gallery')) as HTMLElement | undefined;
    if (existing) { return existing; }
    const gallery = document.createElement('span');
    gallery.className = 'folio-link-gallery';
    block.appendChild(gallery);
    return gallery;
}

function removeCardAndPruneGallery(block: HTMLElement, cardKey: string): void {
    const gallery = Array.from(block.children).find(el => el.classList.contains('folio-link-gallery')) as HTMLElement | undefined;
    if (!gallery) { return; }
    Array.from(gallery.children).forEach(child => {
        if ((child as HTMLElement).dataset.folioCardKey === cardKey) {
            child.remove();
        }
    });
    if (gallery.children.length === 0) {
        gallery.remove();
    }
}

function syncSingleImageLinkExpansion(anchor: HTMLAnchorElement): void {
    const key = anchor.dataset.folioLinkKey ?? '';
    const rawHref = anchor.dataset.folioRawHref ?? '';
    if (!key || !rawHref) { return; }

    const expanded = isLinkExpanded(key);
    anchor.classList.toggle('is-expanded', expanded);

    const next = anchor.nextElementSibling;
    if (next?.classList.contains('folio-image-expand-btn')) {
        next.classList.toggle('is-expanded', expanded);
        next.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        next.setAttribute('title', expanded ? '收起缩略图' : '原地展开缩略图');
    }

    const block = findBlockForImageLink(anchor);
    if (!block) { return; }

    if (!expanded) {
        removeCardAndPruneGallery(block, key);
        return;
    }

    const gallery = ensureGalleryContainer(block);
    const existingCard = Array.from(gallery.children).find(
        el => (el as HTMLElement).dataset.folioCardKey === key
    ) as HTMLElement | undefined;
    if (existingCard) { return; }

    const basename = getLinkBasename(rawHref);
    const labelText = (anchor.textContent ?? '').trim();
    const displayTitle = labelText && labelText !== basename ? `${labelText} (${basename})` : basename;

    const card = document.createElement('span');
    card.className = 'folio-inline-image-card';
    card.dataset.folioCardKey = key;
    card.dataset.folioRawHref = rawHref;

    const head = document.createElement('span');
    head.className = 'folio-inline-card-head';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'folio-inline-card-title';
    titleSpan.textContent = displayTitle;
    titleSpan.title = safeDecodeHref(rawHref);

    const actions = document.createElement('span');
    actions.className = 'folio-inline-card-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'folio-card-btn folio-card-open';
    openBtn.textContent = '打开';
    openBtn.title = '在编辑器中打开原图';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'folio-card-btn folio-card-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '收起缩略图';

    actions.append(openBtn, closeBtn);
    head.append(titleSpan, actions);

    const body = document.createElement('span');
    body.className = 'folio-inline-card-body';

    const img = document.createElement('img');
    img.className = 'folio-inline-thumb';
    img.loading = 'eager';
    img.alt = displayTitle;
    img.title = '点击放大查看 (Lightbox)';

    const fallback = document.createElement('span');
    fallback.className = 'folio-inline-card-fallback';
    fallback.textContent = '正在加载图片…';

    body.append(img, fallback);
    card.append(head, body);
    gallery.appendChild(card);

    img.addEventListener('load', () => {
        card.classList.remove('is-error', 'is-loading');
        onLinkLayoutChanged?.();
    });
    img.addEventListener('error', () => {
        card.classList.remove('is-loading');
        card.classList.add('is-error');
        fallback.textContent = `无法加载图片：${basename}`;
        onLinkLayoutChanged?.();
    });

    card.classList.add('is-loading');
    void requestImageSrc(rawHref, anchor.dataset.folioImgSrc).then(src => {
        if (!card.isConnected) { return; }
        if (!src) {
            card.classList.remove('is-loading');
            card.classList.add('is-error');
            fallback.textContent = `未找到图片：${basename}`;
            return;
        }
        img.src = src;
    });
}

// ─── Lightbox Modal ───────────────────────────────────────────────────────────

class ImageLightbox {
    private _items: LightboxItem[] = [];
    private _index = 0;
    private _zoomed = false;
    private _scale = 1;
    private _bound = false;
    private _dragging = false;
    private _dragStartX = 0;
    private _dragStartY = 0;
    private _dragScrollLeft = 0;
    private _dragScrollTop = 0;

    private _root(): HTMLElement | null {
        return document.getElementById('folio-lightbox');
    }

    public isOpen(): boolean {
        return Boolean(this._root()?.classList.contains('show'));
    }

    private _ensureBound(): void {
        if (this._bound) { return; }
        const root = this._root();
        if (!root) { return; }
        this._bound = true;

        const stage = document.getElementById('folio-lightbox-stage');
        const img = document.getElementById('folio-lightbox-img') as HTMLImageElement | null;

        document.getElementById('folio-lightbox-close')?.addEventListener('click', () => this.close());
        document.getElementById('folio-lightbox-prev')?.addEventListener('click', () => this.step(-1));
        document.getElementById('folio-lightbox-next')?.addEventListener('click', () => this.step(1));
        document.getElementById('folio-lightbox-zoom-toggle')?.addEventListener('click', () => this.toggleZoom());
        document.getElementById('folio-lightbox-open-file')?.addEventListener('click', () => {
            const cur = this._items[this._index];
            if (!cur?.rawHref) { return; }
            latestLinkVscode?.postMessage({
                type: 'open-workspace-file',
                payload: { path: safeDecodeHref(cur.rawHref) }
            });
        });

        stage?.addEventListener('click', (event: MouseEvent) => {
            if (event.target === stage) {
                this.close();
            }
        });

        img?.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            if (!this._dragging) {
                this.toggleZoom();
            }
        });

        img?.addEventListener('load', () => {
            root.classList.remove('has-error');
        });

        img?.addEventListener('error', () => {
            const cur = this._items[this._index];
            const errEl = document.getElementById('folio-lightbox-error');
            if (errEl) {
                errEl.textContent = `无法加载图片：${cur?.rawHref ? getLinkBasename(cur.rawHref) : cur?.title ?? ''}`;
            }
            root.classList.add('has-error');
        });

        stage?.addEventListener('wheel', (event: WheelEvent) => {
            if (!this.isOpen() || (!event.ctrlKey && !event.metaKey)) { return; }
            event.preventDefault();
            const delta = event.deltaY < 0 ? 0.18 : -0.18;
            this._scale = Math.max(0.5, Math.min(4, Number((this._scale + delta).toFixed(2))));
            this._zoomed = Math.abs(this._scale - 1) > 0.01;
            this._applyZoom();
        }, { passive: false });

        stage?.addEventListener('mousedown', (event: MouseEvent) => {
            if (!this._zoomed || event.button !== 0 || event.target === stage) { return; }
            this._dragging = false;
            this._dragStartX = event.clientX;
            this._dragStartY = event.clientY;
            this._dragScrollLeft = stage.scrollLeft;
            this._dragScrollTop = stage.scrollTop;

            const onMove = (moveEvent: MouseEvent) => {
                const dx = moveEvent.clientX - this._dragStartX;
                const dy = moveEvent.clientY - this._dragStartY;
                if (Math.hypot(dx, dy) > 4) {
                    this._dragging = true;
                }
                if (this._dragging) {
                    stage.scrollLeft = this._dragScrollLeft - dx;
                    stage.scrollTop = this._dragScrollTop - dy;
                }
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                window.setTimeout(() => { this._dragging = false; }, 0);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (!this.isOpen()) { return; }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.close();
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                this.step(-1);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                this.step(1);
            } else if (event.key === ' ' || event.key === '0') {
                event.preventDefault();
                this.toggleZoom();
            } else if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                this._zoomed = true;
                this._scale = Math.min(4, Number((this._scale + 0.25).toFixed(2)));
                this._applyZoom();
            } else if (event.key === '-') {
                event.preventDefault();
                this._scale = Math.max(0.5, Number((this._scale - 0.25).toFixed(2)));
                this._zoomed = Math.abs(this._scale - 1) > 0.01;
                this._applyZoom();
            }
        }, true);
    }

    public open(items: LightboxItem[], startKey: string): void {
        this._ensureBound();
        const root = this._root();
        if (!root || items.length === 0) { return; }

        this._items = items;
        const foundIndex = items.findIndex(item => item.key === startKey);
        this._index = foundIndex >= 0 ? foundIndex : 0;
        this._zoomed = false;
        this._scale = 1;

        root.classList.add('show');
        root.setAttribute('aria-hidden', 'false');
        this._renderCurrent();
    }

    public close(): void {
        const root = this._root();
        if (!root) { return; }
        root.classList.remove('show', 'is-zoomed', 'has-error');
        root.setAttribute('aria-hidden', 'true');
        const img = document.getElementById('folio-lightbox-img') as HTMLImageElement | null;
        if (img) {
            img.removeAttribute('src');
            img.style.transform = '';
        }
    }

    public step(delta: number): void {
        if (this._items.length <= 1) { return; }
        this._index = (this._index + delta + this._items.length) % this._items.length;
        this._zoomed = false;
        this._scale = 1;
        this._renderCurrent();
    }

    public toggleZoom(): void {
        this._zoomed = !this._zoomed;
        this._scale = 1;
        this._applyZoom();
    }

    private _applyZoom(): void {
        const root = this._root();
        const img = document.getElementById('folio-lightbox-img') as HTMLImageElement | null;
        const zoomBtn = document.getElementById('folio-lightbox-zoom-toggle');
        if (!root || !img) { return; }

        root.classList.toggle('is-zoomed', this._zoomed);
        img.style.transform = this._scale !== 1 ? `scale(${this._scale})` : '';
        img.style.transformOrigin = 'center center';
        if (zoomBtn) {
            zoomBtn.textContent = this._zoomed ? '适应' : '1:1';
        }
    }

    private _renderCurrent(): void {
        const root = this._root();
        const item = this._items[this._index];
        if (!root || !item) { return; }

        root.classList.remove('has-error');
        this._applyZoom();

        const counter = document.getElementById('folio-lightbox-counter');
        const titleEl = document.getElementById('folio-lightbox-title');
        const openBtn = document.getElementById('folio-lightbox-open-file') as HTMLButtonElement | null;
        const prevBtn = document.getElementById('folio-lightbox-prev') as HTMLButtonElement | null;
        const nextBtn = document.getElementById('folio-lightbox-next') as HTMLButtonElement | null;
        const img = document.getElementById('folio-lightbox-img') as HTMLImageElement | null;
        const errEl = document.getElementById('folio-lightbox-error');

        if (counter) {
            counter.textContent = `${this._index + 1} / ${this._items.length}`;
        }
        if (titleEl) {
            titleEl.textContent = item.title;
            titleEl.title = item.rawHref ? safeDecodeHref(item.rawHref) : item.title;
        }
        if (openBtn) {
            openBtn.style.display = item.rawHref ? '' : 'none';
        }
        const multi = this._items.length > 1;
        if (prevBtn) { prevBtn.style.display = multi ? '' : 'none'; }
        if (nextBtn) { nextBtn.style.display = multi ? '' : 'none'; }

        if (!img) { return; }
        const requestedIndex = this._index;
        img.removeAttribute('src');
        img.alt = item.title;

        if (item.src) {
            img.src = item.src;
            return;
        }

        if (item.rawHref) {
            void requestImageSrc(item.rawHref).then(src => {
                if (!this.isOpen() || this._index !== requestedIndex) { return; }
                if (!src) {
                    if (errEl) {
                        errEl.textContent = `未找到图片：${getLinkBasename(item.rawHref!)}`;
                    }
                    root.classList.add('has-error');
                    return;
                }
                item.src = src;
                img.src = src;
            });
        }
    }
}

const imageLightbox = new ImageLightbox();

function collectLightboxItems(): LightboxItem[] {
    const root = document.getElementById('document-content');
    if (!root) { return []; }

    const items: LightboxItem[] = [];
    const seenImg = new WeakSet<HTMLImageElement>();
    const nodes = root.querySelectorAll<HTMLElement>('a.folio-image-link, img:not(.folio-inline-thumb)');

    nodes.forEach((node, idx) => {
        if (node.closest('.katex, .folio-heading-tools, .folio-table-tools, .folio-link-gallery')) {
            return;
        }
        if (node instanceof HTMLAnchorElement) {
            const innerImg = node.querySelector('img');
            if (innerImg) {
                seenImg.add(innerImg);
            }
            const rawHref = node.dataset.folioRawHref ?? node.getAttribute('href') ?? '';
            const basename = getLinkBasename(rawHref);
            const label = (node.textContent ?? '').trim();
            const title = label && label !== basename ? `${label} · ${basename}` : basename;
            items.push({
                key: node.dataset.folioLinkKey || `link-${idx}`,
                src: node.dataset.folioImgSrc || '',
                rawHref,
                title,
            });
            return;
        }

        if (node instanceof HTMLImageElement) {
            if (seenImg.has(node)) { return; }
            const parentAnchor = node.closest('a[href]') as HTMLAnchorElement | null;
            if (parentAnchor && isExternalHref(parentAnchor.getAttribute('href') ?? '')) {
                return;
            }
            const key = node.dataset.folioImgKey || `img-${idx}`;
            node.dataset.folioImgKey = key;
            items.push({
                key,
                src: node.currentSrc || node.src || '',
                title: node.alt || getLinkBasename(node.src || 'Image'),
            });
        }
    });

    return items;
}

function ensureLinkDelegation(): void {
    if (linkDelegationBound) { return; }
    const contentEl = document.getElementById('document-content');
    if (!contentEl) { return; }
    linkDelegationBound = true;

    contentEl.addEventListener('mousedown', (event: MouseEvent) => {
        linkDownX = event.clientX;
        linkDownY = event.clientY;
    });

    contentEl.addEventListener('click', (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) { return; }

        const expandBtn = target.closest<HTMLElement>('.folio-image-expand-btn');
        if (expandBtn) {
            event.preventDefault();
            event.stopPropagation();
            const anchor = expandBtn.previousElementSibling as HTMLAnchorElement | null;
            if (anchor?.classList.contains('folio-image-link')) {
                const key = anchor.dataset.folioLinkKey ?? '';
                if (key) {
                    perLinkExpandOverrides.set(key, !isLinkExpanded(key));
                    syncSingleImageLinkExpansion(anchor);
                    onLinkLayoutChanged?.();
                }
            }
            return;
        }

        const card = target.closest<HTMLElement>('.folio-inline-image-card');
        if (card) {
            const key = card.dataset.folioCardKey ?? '';
            const rawHref = card.dataset.folioRawHref ?? '';
            if (target.closest('.folio-card-close')) {
                event.preventDefault();
                event.stopPropagation();
                if (key) {
                    perLinkExpandOverrides.set(key, false);
                    const anchor = contentEl.querySelector<HTMLAnchorElement>(`a.folio-image-link[data-folio-link-key="${CSS.escape(key)}"]`);
                    if (anchor) {
                        syncSingleImageLinkExpansion(anchor);
                    } else {
                        const block = card.parentElement?.parentElement;
                        card.remove();
                        if (block) {
                            removeCardAndPruneGallery(block, key);
                        }
                    }
                    onLinkLayoutChanged?.();
                }
                return;
            }
            if (target.closest('.folio-card-open')) {
                event.preventDefault();
                event.stopPropagation();
                if (rawHref) {
                    latestLinkVscode?.postMessage({
                        type: 'open-workspace-file',
                        payload: { path: safeDecodeHref(rawHref) }
                    });
                }
                return;
            }
            if (target.closest('.folio-inline-thumb') && key) {
                event.preventDefault();
                event.stopPropagation();
                imageLightbox.open(collectLightboxItems(), key);
                return;
            }
            return;
        }

        const moved = Math.hypot(event.clientX - linkDownX, event.clientY - linkDownY);
        const selected = window.getSelection()?.toString().trim() ?? '';
        if (moved > 5 || selected.length > 0) {
            return;
        }

        const anchor = target.closest<HTMLAnchorElement>('a[href]');
        if (anchor && !anchor.closest('.folio-heading-tools, .folio-table-tools')) {
            const rawHref = anchor.getAttribute('href')?.trim() ?? '';
            if (!rawHref) { return; }

            if (rawHref.startsWith('#')) {
                event.preventDefault();
                const targetId = safeDecodeHref(rawHref.slice(1));
                const heading = document.getElementById(targetId);
                heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }

            if (isExternalHref(rawHref)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (anchor.classList.contains('folio-image-link') || isImageHref(rawHref)) {
                if (event.altKey || event.metaKey || event.ctrlKey) {
                    latestLinkVscode?.postMessage({
                        type: 'open-workspace-file',
                        payload: { path: safeDecodeHref(rawHref) }
                    });
                } else {
                    const key = anchor.dataset.folioLinkKey ?? '';
                    imageLightbox.open(collectLightboxItems(), key);
                }
                return;
            }

            latestLinkVscode?.postMessage({
                type: 'open-workspace-file',
                payload: { path: safeDecodeHref(rawHref) }
            });
            return;
        }

        const img = target.closest<HTMLImageElement>('img:not(.folio-inline-thumb)');
        if (img && !img.closest('.katex, .folio-heading-tools, .folio-table-tools')) {
            const items = collectLightboxItems();
            const key = img.dataset.folioImgKey ?? '';
            if (key) {
                event.preventDefault();
                event.stopPropagation();
                imageLightbox.open(items, key);
            }
        }
    });
}

export function enhanceLinksAndImages(vscode: any, onLayoutChanged?: () => void): void {
    latestLinkVscode = vscode;
    onLinkLayoutChanged = onLayoutChanged;
    ensureLinkDelegation();

    const root = document.getElementById('document-content');
    if (!root) { return; }

    // Clear stale inline galleries before re-enhancing current DOM
    root.querySelectorAll('.folio-link-gallery').forEach(node => node.remove());

    const occurrenceCounter = new Map<string, number>();
    const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
    anchors.forEach(anchor => {
        if (anchor.closest('.folio-heading-tools, .folio-table-tools, .folio-link-gallery')) {
            return;
        }
        const rawHref = anchor.getAttribute('href')?.trim() ?? '';
        if (!rawHref || rawHref.startsWith('#') || isExternalHref(rawHref)) {
            return;
        }

        if (isImageHref(rawHref)) {
            const count = (occurrenceCounter.get(rawHref) ?? 0) + 1;
            occurrenceCounter.set(rawHref, count);
            const key = `${rawHref}::${count}`;

            anchor.classList.add('folio-image-link');
            anchor.dataset.folioRawHref = rawHref;
            anchor.dataset.folioLinkKey = key;
            if (!anchor.title) {
                anchor.title = '点击预览大图（Alt/Cmd+点击在编辑器中打开）';
            }

            if (!anchor.querySelector('img')) {
                let expandBtn = anchor.nextElementSibling as HTMLButtonElement | null;
                if (!expandBtn || !expandBtn.classList.contains('folio-image-expand-btn')) {
                    expandBtn = document.createElement('button');
                    expandBtn.type = 'button';
                    expandBtn.className = 'folio-image-expand-btn';
                    expandBtn.innerHTML = EXPAND_ICON_SVG;
                    anchor.insertAdjacentElement('afterend', expandBtn);
                }
                syncSingleImageLinkExpansion(anchor);
            }
            return;
        }

        anchor.classList.add('folio-file-link');
        anchor.dataset.folioRawHref = rawHref;
        if (!anchor.title) {
            anchor.title = `点击在编辑器中打开 ${safeDecodeHref(rawHref)}`;
        }
    });

    const imgs = root.querySelectorAll<HTMLImageElement>('img:not(.folio-inline-thumb)');
    imgs.forEach((img, idx) => {
        if (img.closest('.katex, .folio-heading-tools, .folio-table-tools, .folio-link-gallery')) {
            return;
        }
        const parentAnchor = img.closest('a[href]') as HTMLAnchorElement | null;
        if (parentAnchor && isExternalHref(parentAnchor.getAttribute('href') ?? '')) {
            return;
        }
        if (!img.dataset.folioImgKey) {
            img.dataset.folioImgKey = `img-${idx}`;
        }
    });
}
