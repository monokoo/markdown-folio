export class Renderer {
    private _container: HTMLElement;

    constructor(containerId: string) {
        this._container = document.getElementById(containerId) || document.body;
    }

    public render(html: string) {
        // Cache already-rendered Mermaid diagram nodes by their source text to prevent flicker on edit
        const renderedMermaidCache = new Map<string, HTMLElement[]>();
        this._container.querySelectorAll<HTMLElement>('code.mermaid[data-processed="true"]').forEach(el => {
            const src = el.dataset.mermaidSource;
            if (src && el.querySelector('svg')) {
                const list = renderedMermaidCache.get(src) || [];
                list.push(el);
                renderedMermaidCache.set(src, list);
            }
        });

        this._container.innerHTML = html;

        if (renderedMermaidCache.size > 0) {
            this._container.querySelectorAll<HTMLElement>('code.language-mermaid').forEach(newEl => {
                const src = newEl.textContent || '';
                const cachedList = renderedMermaidCache.get(src);
                if (cachedList && cachedList.length > 0) {
                    const cachedEl = cachedList.shift()!;
                    newEl.replaceWith(cachedEl);
                }
            });
        }
    }
}
