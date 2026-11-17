import { TocItem } from '../src/shared/types';
import { expandCollapsedAncestors } from './smartDocument';

export class Toc {
    private _container: HTMLElement;
    private _observer: IntersectionObserver | null = null;
    private _filterQuery = '';
    private _activeSlug = '';
    private _itemBySlug = new Map<string, HTMLElement>();
    private _activeItemEl: HTMLElement | null = null;

    constructor(containerId: string) {
        this._container = document.getElementById(containerId) || document.body;
        this._initDrawerControls();
    }

    private _initDrawerControls() {
        const drawerBtn = document.getElementById('toc-drawer-toggle');
        const backdrop = document.getElementById('toc-backdrop');

        drawerBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.innerWidth <= 960) {
                this._container.classList.toggle('drawer-open');
                backdrop?.classList.toggle('show', this._container.classList.contains('drawer-open'));
            } else {
                // Wide screen: un-collapse sidebar
                this._container.classList.remove('sidebar-collapsed');
                this._container.style.display = '';
                this.syncFabVisibility();
                const syncPos = (window as any).syncToolbarPosition;
                if (typeof syncPos === 'function') { syncPos(); }
            }
        });

        backdrop?.addEventListener('click', () => {
            this.closeDrawer();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 960) {
                backdrop?.classList.remove('show');
                this._container.classList.remove('drawer-open');
            }
            this.syncFabVisibility();
        });
    }

    public closeDrawer() {
        this._container.classList.remove('drawer-open');
        document.getElementById('toc-backdrop')?.classList.remove('show');
    }

    public syncFabVisibility() {
        const drawerBtn = document.getElementById('toc-drawer-toggle');
        if (!drawerBtn) { return; }
        const isHiddenByStyle = this._container.style.display === 'none' || this._container.classList.contains('sidebar-collapsed');
        const isNarrowScreen = window.innerWidth <= 960;
        if (isHiddenByStyle || isNarrowScreen) {
            drawerBtn.classList.add('visible');
        } else {
            drawerBtn.classList.remove('visible');
        }
    }

    public render(tocItems: TocItem[]) {
        if (tocItems.length === 0) {
            this._itemBySlug.clear();
            this._activeItemEl = null;
            this._container.innerHTML = `
                <div class="toc-header-bar">
                    <span class="toc-header-title">Contents</span>
                    <button type="button" class="toc-close-btn" title="Hide Contents">&times;</button>
                </div>
                <div style="padding: 20px 14px; font-size: 12px; color: var(--text-muted);">No headings found.</div>
            `;
            this._bindHeaderClose();
            this.syncFabVisibility();
            return;
        }

        const html = tocItems
            .map(item => {
                const normalizedText = item.text.normalize('NFC');
                const escapedText = normalizedText
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                const isActive = this._activeSlug && item.slug === this._activeSlug ? ' active' : '';
                return `
                    <div class="toc-item level-${item.level}${isActive}" data-slug="${item.slug}" title="${escapedText.replace(/"/g, '&quot;')}">
                        ${escapedText}
                    </div>
                `;
            })
            .join('');

        // Preserve focus if user is actively typing in the TOC search input
        const existingInput = this._container.querySelector<HTMLInputElement>('.toc-search-input');
        const wasFocused = document.activeElement === existingInput;

        const listContainer = this._container.querySelector<HTMLElement>('.toc-list');
        const countBadge = this._container.querySelector<HTMLElement>('.toc-count-badge');

        if (listContainer && existingInput) {
            listContainer.innerHTML = html;
            if (countBadge) {
                countBadge.textContent = String(tocItems.length);
            }
        } else {
            this._container.innerHTML = `
                <div class="toc-header-bar">
                    <div class="toc-header-left">
                        <span class="toc-header-title">Contents</span>
                        <span class="toc-count-badge">${tocItems.length}</span>
                    </div>
                    <button type="button" class="toc-close-btn" title="Hide Contents">&times;</button>
                </div>
                <div class="toc-search-wrap">
                    <input type="search" class="toc-search-input" placeholder="Filter headings..." value="${this._filterQuery.replace(/"/g, '&quot;')}" />
                </div>
                <div class="toc-list">
                    ${html}
                </div>
            `;
            this._bindHeaderClose();
            this._bindSearchInput();
            if (wasFocused) {
                const newInput = this._container.querySelector<HTMLInputElement>('.toc-search-input');
                newInput?.focus();
            }
        }

        this._applyFilter();
        this._initEventListeners();
        this._bindScrollSync();
        this.syncFabVisibility();
    }

    private _bindHeaderClose() {
        const closeBtn = this._container.querySelector('.toc-close-btn');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.innerWidth <= 960) {
                this.closeDrawer();
            } else {
                this._container.classList.add('sidebar-collapsed');
                this.syncFabVisibility();
                const syncPos = (window as any).syncToolbarPosition;
                if (typeof syncPos === 'function') { syncPos(); }
            }
        });
    }

    private _bindSearchInput() {
        const input = this._container.querySelector<HTMLInputElement>('.toc-search-input');
        input?.addEventListener('input', () => {
            this._filterQuery = input.value.trim().toLowerCase();
            this._applyFilter();
        });
    }

    private _applyFilter() {
        const q = this._filterQuery;
        this._container.querySelectorAll<HTMLElement>('.toc-item').forEach(item => {
            if (!q) {
                item.style.display = '';
                return;
            }
            const text = (item.textContent || '').toLowerCase();
            item.style.display = text.includes(q) ? '' : 'none';
        });
    }

    private _initEventListeners() {
        this._itemBySlug.clear();
        this._activeItemEl = null;
        this._container.querySelectorAll<HTMLElement>('.toc-item').forEach(item => {
            const slug = item.getAttribute('data-slug') || '';
            if (slug) {
                this._itemBySlug.set(slug, item);
            }
            if (item.classList.contains('active')) {
                this._activeItemEl = item;
            }
            item.addEventListener('click', () => {
                const element = slug ? document.getElementById(slug) : null;
                if (element) {
                    expandCollapsedAncestors(element);
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    this._setActiveSlug(slug, true);
                }
                if (window.innerWidth <= 960) {
                    this.closeDrawer();
                }
            });
        });
    }

    private _bindScrollSync() {
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }

        const headings = document.querySelectorAll<HTMLElement>('#document-content h1, #document-content h2, #document-content h3, #document-content h4, #document-content h5, #document-content h6');
        if (headings.length === 0) {
            return;
        }

        const scrollRoot = document.getElementById('document-container');
        this._observer = new IntersectionObserver(
            entries => {
                const visible = entries
                    .filter(entry => entry.isIntersecting)
                    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

                if (visible.length > 0) {
                    const id = (visible[0].target as HTMLElement).id;
                    if (id) {
                        this._setActiveSlug(id, false);
                    }
                }
            },
            {
                root: scrollRoot,
                threshold: 0.1,
                rootMargin: '-10% 0px -60% 0px'
            }
        );

        headings.forEach(heading => this._observer?.observe(heading));
    }

    private _setActiveSlug(slug: string, smoothScroll = false) {
        if (this._activeSlug === slug && this._activeItemEl?.isConnected) {
            return;
        }
        this._activeSlug = slug;
        if (this._activeItemEl) {
            this._activeItemEl.classList.remove('active');
        }
        const nextEl = this._itemBySlug.get(slug) ?? null;
        if (nextEl) {
            nextEl.classList.add('active');
            if (nextEl.style.display !== 'none') {
                nextEl.scrollIntoView({ block: 'nearest', behavior: smoothScroll ? 'smooth' : 'auto' });
            }
        }
        this._activeItemEl = nextEl;
    }
}
