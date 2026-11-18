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
import { expandCollapsedAncestors } from './smartDocument';

export class ScrollSync {
    private _container: HTMLElement | null;
    private _index: Array<{ line: number; el: HTMLElement; top: number }> = [];
    private _allAnchors: Array<{ line: number; el: HTMLElement }> = [];
    private _dirty = true;
    private _toolbarOffset = 0;
    private _enabled: boolean = true;

    // Phase 2: loop guard & coalescing fields
    private _lastInboundTimestamp = 0;
    private _lastInboundScrollAt = 0;
    private _suppressRevealUntil = 0;
    private _revealEventCounter = 0;
    private _debounceRevealTimer: ReturnType<typeof setTimeout> | null = null;
    private _pendingTargetLine: number | null = null;
    private _pendingRapidStream = false;
    private _scrollRafId: number | null = null;

    constructor(private vscode: any, containerId: string) {
        this._container = document.getElementById(containerId);

        // Invalidate cached anchor offsets when zoom changes; layout sync re-measures lazily
        document.addEventListener('markdown-folio:zoom-changed', () => {
            this.markDirty();
        });

        // Phase 2: listen to preview scroll, debounce 100ms, post reveal-line
        this._container?.addEventListener('scroll', () => {
            this._onContainerScroll();
        }, { passive: true });
    }

    /** Mark anchor geometry index stale so the next scroll sync operation refreshes it lazily. */
    public markDirty(): void {
        this._dirty = true;
    }

    private _ensureIndex(): void {
        if (this._dirty) {
            this.rebuildIndex();
        }
    }

    /** Rebuild anchor index and pre-cache element offsets from current DOM state. */
    public rebuildIndex(): void {
        const container = this._container;
        if (!container) { return; }
        this._dirty = false;
        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        this._toolbarOffset = this._getToolbarOffset(containerRect);
        const rawAnchors = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'))
            .map(el => ({
                line: parseInt(el.getAttribute('data-source-line') ?? '0', 10),
                el
            }))
            .sort((a, b) => a.line - b.line);
        this._allAnchors = rawAnchors;
        this._index = rawAnchors
            .filter(item => !item.el.closest('.folio-section-body.is-collapsed'))
            .map(item => ({
                line: item.line,
                el: item.el,
                top: scrollTop + (item.el.getBoundingClientRect().top - containerRect.top)
            }));
    }

    /** Enable or disable scroll sync without destroying the instance. */
    public setEnabled(value: boolean): void {
        this._enabled = value;
    }

    /** Route messages from the extension host. */
    public handleMessage(message: any): void {
        if (!this._enabled) { return; }
        if (message.type === 'scroll-to-line') {
            const now = Date.now();
            const isRapidStream = now - this._lastInboundScrollAt < 260;
            this._lastInboundScrollAt = now;
            this._lastInboundTimestamp = now;
            this._suppressRevealUntil = now + 900;
            this._pendingTargetLine = message.payload.line as number;
            this._pendingRapidStream = isRapidStream;
            if (this._scrollRafId !== null) {
                return;
            }
            this._scrollRafId = window.requestAnimationFrame(() => {
                this._scrollRafId = null;
                this._flushPendingScroll();
            });
        }
    }

    private _flushPendingScroll(): void {
        if (this._pendingTargetLine === null) { return; }
        const targetLine = this._pendingTargetLine;
        const isRapidStream = this._pendingRapidStream;
        this._pendingTargetLine = null;
        this._scrollToLine(targetLine, isRapidStream);
    }

    public dispose(): void {
        this._index = [];
        this._allAnchors = [];
        this._pendingTargetLine = null;
        if (this._debounceRevealTimer) {
            clearTimeout(this._debounceRevealTimer);
            this._debounceRevealTimer = null;
        }
        if (this._scrollRafId !== null) {
            window.cancelAnimationFrame(this._scrollRafId);
            this._scrollRafId = null;
        }
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
        if (!container) { return null; }
        this._ensureIndex();
        if (this._index.length === 0) { return null; }

        const targetOffset = container.scrollTop + this._toolbarOffset + 16; // +16px tolerance

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

    private _scrollToLine(targetLine: number, isRapidStream = false): void {
        const container = this._container;
        if (!container) { return; }
        this._ensureIndex();

        // Only search collapsed sections when collapsed content actually exists in the DOM
        if (this._allAnchors.length > 0 && container.querySelector('.folio-section-body.is-collapsed') !== null) {
            let loAll = 0;
            let hiAll = this._allAnchors.length - 1;
            let bestAllIdx = -1;
            while (loAll <= hiAll) {
                const mid = (loAll + hiAll) >>> 1;
                if (this._allAnchors[mid].line <= targetLine) {
                    bestAllIdx = mid;
                    loAll = mid + 1;
                } else {
                    hiAll = mid - 1;
                }
            }
            const candidateEl = bestAllIdx >= 0 ? this._allAnchors[bestAllIdx].el : null;
            if (candidateEl && expandCollapsedAncestors(candidateEl)) {
                this.rebuildIndex();
            }
        }
        if (this._index.length === 0) { return; }

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
            this._suppressRevealUntil = Date.now() + (isRapidStream ? 220 : 500);
            if (isRapidStream) {
                container.scrollTop = 0;
            } else {
                container.scrollTo({ top: 0, behavior: 'smooth' });
            }
            return;
        }

        const low = this._index[lowIdx];
        const high = lowIdx + 1 < this._index.length ? this._index[lowIdx + 1] : undefined;

        let targetTop: number;
        if (!high || low.line === high.line) {
            targetTop = low.top - this._toolbarOffset;
        } else {
            const fraction = (targetLine - low.line) / (high.line - low.line);
            const lowPos = low.top - this._toolbarOffset;
            const highPos = high.top - this._toolbarOffset;
            targetTop = lowPos + fraction * (highPos - lowPos);
        }

        const clampedTop = Math.max(0, targetTop);
        const useSmooth = !isRapidStream && Math.abs(container.scrollTop - clampedTop) >= container.clientHeight * 1.25;
        this._suppressRevealUntil = Date.now() + (useSmooth ? 750 : 220);

        if (useSmooth) {
            container.scrollTo({ top: clampedTop, behavior: 'smooth' });
        } else {
            container.scrollTop = clampedTop;
        }
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
