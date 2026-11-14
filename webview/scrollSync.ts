/**
 * ScrollSync — Phase 1 + Phase 2
 *
 * Phase 1: listens for 'scroll-to-line' messages from extension host → scrolls preview.
 * Phase 2: listens to container scroll events → posts 'reveal-line' to extension host.
 *
 * Loop guard: when a 'scroll-to-line' arrives we suppress reverse sync briefly
 * to prevent the editor → preview → editor → … feedback loop.
 *
 * Uses getBoundingClientRect() instead of offsetTop to handle
 * transform:scale() on #document-paper correctly at any zoom level.
 */
export class ScrollSync {
    private _container: HTMLElement | null;
    private _index: Array<{ line: number; el: HTMLElement; top: number }> = [];
    private _enabled: boolean = true;

    // Phase 2: loop guard fields
    private _lastInboundTimestamp = 0;
    private _suppressRevealUntil = 0;
    private _revealEventCounter = 0;
    private _debounceRevealTimer: ReturnType<typeof setTimeout> | null = null;
    private _reindexTimer: ReturnType<typeof setTimeout> | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    constructor(private vscode: any, containerId: string) {
        this._container = document.getElementById(containerId);

        // Rebuild index when zoom changes (transform:scale shifts all positions)
        document.addEventListener('markdown-folio:zoom-changed', () => {
            this.rebuildIndex();
        });

        // Observe document paper resize (e.g. async images loading or panel resize) to keep cached offsets fresh
        const paper = document.getElementById('document-paper');
        if (paper && typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._reindexTimer) {
                    clearTimeout(this._reindexTimer);
                }
                this._reindexTimer = setTimeout(() => {
                    this._reindexTimer = null;
                    this.rebuildIndex();
                }, 80);
            });
            this._resizeObserver.observe(paper);
        }

        // Phase 2: listen to preview scroll, debounce 100ms, post reveal-line
        this._container?.addEventListener('scroll', () => {
            this._onContainerScroll();
        }, { passive: true });
    }

    /** Rebuild anchor index and pre-cache element offsets from current DOM state. */
    public rebuildIndex(): void {
        const container = this._container;
        if (!container) { return; }
        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const anchors = container.querySelectorAll<HTMLElement>('[data-source-line]');
        this._index = Array.from(anchors)
            .map(el => ({
                line: parseInt(el.getAttribute('data-source-line') ?? '0', 10),
                el,
                top: scrollTop + (el.getBoundingClientRect().top - containerRect.top)
            }))
            .sort((a, b) => a.line - b.line);
    }

    /** Enable or disable scroll sync without destroying the instance. */
    public setEnabled(value: boolean): void {
        this._enabled = value;
    }

    /** Route messages from the extension host. */
    public handleMessage(message: any): void {
        if (!this._enabled) { return; }
        if (message.type === 'scroll-to-line') {
            // Record inbound timestamp for loop guard BEFORE scrolling
            this._lastInboundTimestamp = Date.now();
            this._suppressRevealUntil = Date.now() + 900;
            this._scrollToLine(message.payload.line as number);
        }
    }

    public dispose(): void {
        this._index = [];
        if (this._debounceRevealTimer) {
            clearTimeout(this._debounceRevealTimer);
            this._debounceRevealTimer = null;
        }
        if (this._reindexTimer) {
            clearTimeout(this._reindexTimer);
            this._reindexTimer = null;
        }
        this._resizeObserver?.disconnect();
    }

    // ─── Phase 2 ────────────────────────────────────────────────────────────

    private _onContainerScroll(): void {
        if (!this._enabled) { return; }
        if (Date.now() < this._suppressRevealUntil) { return; }

        // Debounce: only fire 100ms after scroll stops
        if (this._debounceRevealTimer) {
            clearTimeout(this._debounceRevealTimer);
        }
        this._debounceRevealTimer = setTimeout(() => {
            this._debounceRevealTimer = null;
            this._emitRevealLine();
        }, 100);
    }

    private _emitRevealLine(): void {
        if (!this._enabled) { return; }

        // Loop guard: suppress if a scroll-to-line arrived very recently.
        if (Date.now() < this._suppressRevealUntil || Date.now() - this._lastInboundTimestamp < 200) { return; }

        const line = this._findTopAnchorLine();
        if (line === null) { return; }

        this.vscode.postMessage({
            type: 'reveal-line',
            payload: { line, eventId: ++this._revealEventCounter }
        });
    }

    /** Find the source line of the anchor element closest to (and at/above) the visible top via O(log N) binary search. */
    private _findTopAnchorLine(): number | null {
        const container = this._container;
        if (!container || this._index.length === 0) { return null; }

        const containerRect = container.getBoundingClientRect();
        const toolbarOffset = this._getToolbarOffset(containerRect);
        const targetOffset = container.scrollTop + toolbarOffset + 16; // +16px tolerance

        let lo = 0;
        let hi = this._index.length - 1;
        let bestIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (this._index[mid].top <= targetOffset) {
                bestIdx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return bestIdx >= 0 ? this._index[bestIdx].line : (this._index[0]?.line ?? null);
    }

    // ─── Phase 1 ────────────────────────────────────────────────────────────

    private _scrollToLine(targetLine: number): void {
        const container = this._container;
        if (!container || this._index.length === 0) { return; }

        // Binary search for low anchor (largest line <= targetLine) and high (smallest line > targetLine)
        let lo = 0;
        let hi = this._index.length - 1;
        let lowIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (this._index[mid].line <= targetLine) {
                lowIdx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (lowIdx < 0) {
            // Target is before all anchors — scroll to top
            container.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

        const low = this._index[lowIdx];
        const high = lowIdx + 1 < this._index.length ? this._index[lowIdx + 1] : undefined;

        const containerRect = container.getBoundingClientRect();
        const toolbarOffset = this._getToolbarOffset(containerRect);

        let targetTop: number;
        if (!high || low.line === high.line) {
            targetTop = low.top - toolbarOffset;
        } else {
            const fraction = (targetLine - low.line) / (high.line - low.line);
            const lowPos = low.top - toolbarOffset;
            const highPos = high.top - toolbarOffset;
            targetTop = lowPos + fraction * (highPos - lowPos);
        }

        container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }

    private _getToolbarOffset(containerRect: DOMRect): number {
        const toolbar = document.getElementById('toolbar');
        if (!toolbar || toolbar.style.display === 'none') {
            return 0;
        }

        const rect = toolbar.getBoundingClientRect();
        if (rect.height === 0) {
            return 0;
        }

        return Math.max(0, rect.bottom - containerRect.top + 12);
    }
}
