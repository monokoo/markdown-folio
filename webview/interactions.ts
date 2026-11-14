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
                if (parent.closest('.folio-heading-tools, .folio-table-tools, .code-block-header, .katex-mathml, script, style')) {
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
