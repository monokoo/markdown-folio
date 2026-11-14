import MarkdownIt from 'markdown-it';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItToc from 'markdown-it-toc-done-right';
import markdownItKatex from '@vscode/markdown-it-katex';
import markdownItTaskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import type { LanguageFn } from 'highlight.js';
import apache from 'highlight.js/lib/languages/apache';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import glsl from 'highlight.js/lib/languages/glsl';
import gradle from 'highlight.js/lib/languages/gradle';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import http from 'highlight.js/lib/languages/http';
import latex from 'highlight.js/lib/languages/latex';
import nginx from 'highlight.js/lib/languages/nginx';
import nix from 'highlight.js/lib/languages/nix';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import vim from 'highlight.js/lib/languages/vim';
import { TocItem, slugify } from '../shared/types';

const EXTRA_HLJS_LANGUAGES: Array<[string, LanguageFn]> = [
    ['apache', apache],
    ['clojure', clojure],
    ['cmake', cmake],
    ['dart', dart],
    ['dockerfile', dockerfile],
    ['dos', dos],
    ['elixir', elixir],
    ['erlang', erlang],
    ['glsl', glsl],
    ['gradle', gradle],
    ['groovy', groovy],
    ['haskell', haskell],
    ['http', http],
    ['latex', latex],
    ['nginx', nginx],
    ['nix', nix],
    ['powershell', powershell],
    ['properties', properties],
    ['protobuf', protobuf],
    ['scala', scala],
    ['vim', vim],
];

for (const [name, languageFn] of EXTRA_HLJS_LANGUAGES) {
    if (!hljs.getLanguage(name)) {
        hljs.registerLanguage(name, languageFn);
    }
}

const SOURCE_LINE_TARGETS = new Set([
    'paragraph_open', 'heading_open', 'list_item_open',
    'blockquote_open', 'table_open', 'fence', 'hr', 'html_block'
]);

export class MarkdownEngine {
    private md: MarkdownIt;

    constructor() {
        this.md = new MarkdownIt({
            html: true,
            linkify: true,
            typographer: false,
            highlight: (str, lang) => {
                // This highlight fn is called by the default fence renderer only,
                // but we override fence below — so this path is only hit if our
                // override doesn't match. Keep it as safe fallback.
                const language = lang?.trim();
                if (language && hljs.getLanguage(language)) {
                    try {
                        return this.highlightInner(str, language);
                    } catch (__) { }
                }
                if (!language) {
                    return this.highlightQuotedStrings(str);
                }
                return '';
            }
        })
            .use(markdownItAnchor, {
                permalink: false,
                slugify: slugify
            })
            .use(markdownItToc, { containerClass: 'auto-toc', listType: 'ul' })
            .use(markdownItKatex)
            .use(markdownItTaskLists, { enabled: true });

        // Override validateLink to allow all image data URIs (default rejects svg+xml)
        const defaultValidateLink = this.md.validateLink.bind(this.md);
        this.md.validateLink = (url: string) => {
            if (/^data:image\//i.test(url)) { return true; }
            return defaultValidateLink(url);
        };

        this.md.renderer.rules.code_inline = (tokens, idx) => {
            return `<code class="hljs code-inline">${this.highlightQuotedStrings(tokens[idx].content)}</code>`;
        };

        // Wrap tables in a scrollable container for wide-table overflow
        this.md.renderer.rules.table_open = (tokens, idx) => {
            const sourceLine = tokens[idx].attrGet('data-source-line') ?? '';
            const slAttr = sourceLine ? ` data-source-line="${sourceLine}"` : '';
            return `<div class="table-wrapper"${slAttr}><table>`;
        };
        this.md.renderer.rules.table_close = () => '</table></div>';

        // Override fence renderer so data-source-line attr appears on <pre>.
        // The default fence renderer ignores token attrs when highlight() returns a full <pre>.
        // NOTE: if a future refactor replaces <pre> with <div class="mermaid">,
        // transfer data-source-line from the pre to the new div to keep scroll sync anchors.
        const md = this.md;
        md.renderer.rules.fence = (tokens, idx) => {
            const token = tokens[idx];
            const sourceLine = token.attrGet('data-source-line') ?? '';
            const rawLang = token.info ? token.info.trim().split(/\s+/)[0] : '';
            const escapedLang = rawLang ? md.utils.escapeHtml(rawLang) : '';
            const langClass = escapedLang ? ` language-${escapedLang}` : '';

            // Mermaid: skip highlighter, preserve class for webview detection
            if (rawLang === 'mermaid') {
                const escaped = md.utils.escapeHtml(token.content);
                return `<pre data-source-line="${sourceLine}"><code class="language-mermaid">${escaped}</code></pre>`;
            }

            let inner: string;
            if (rawLang && hljs.getLanguage(rawLang)) {
                try {
                    inner = this.highlightMemberRoots(
                        hljs.highlight(token.content, { language: rawLang, ignoreIllegals: true }).value
                    );
                } catch (__) {
                    inner = md.utils.escapeHtml(token.content);
                }
            } else if (!rawLang) {
                inner = this.highlightQuotedStrings(token.content);
            } else {
                inner = md.utils.escapeHtml(token.content);
            }

            return `<pre data-source-line="${sourceLine}"><code class="hljs${langClass}">${inner}</code></pre>`;
        };
    }

    /**
     * Render markdown to HTML.
     * @param markdown - Markdown content (frontmatter already stripped).
     * @param lineOffset - Lines stripped from the top (frontmatter block count).
     */
    public render(markdown: string, lineOffset: number = 0): string {
        return this.renderWithToc(markdown, lineOffset).html;
    }

    /**
     * Render markdown to HTML and extract TOC in a single AST parse pass.
     */
    public renderWithToc(markdown: string, lineOffset: number = 0): { html: string; toc: TocItem[] } {
        const normalized = markdown.normalize('NFC');
        const env: any = {};
        const tokens = this.md.parse(normalized, env);
        const toc: TocItem[] = [];
        const slugCounts = new Map<string, number>();

        // Single pass: inject data-source-line and extract heading TOC items
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.map && SOURCE_LINE_TARGETS.has(token.type)) {
                token.attrSet('data-source-line', String(token.map[0] + lineOffset));
            }
            if (token.type === 'heading_open') {
                const level = Number(token.tag.replace('h', ''));
                const inline = tokens[i + 1];
                if (inline && inline.type === 'inline') {
                    const text = inline.content.trim();
                    if (text) {
                        const anchorId = token.attrGet('id');
                        let slug: string;
                        if (anchorId) {
                            slug = anchorId;
                        } else {
                            const baseSlug = slugify(text);
                            const duplicateIndex = slugCounts.get(baseSlug) ?? 0;
                            slugCounts.set(baseSlug, duplicateIndex + 1);
                            slug = duplicateIndex === 0 ? baseSlug : `${baseSlug}-${duplicateIndex}`;
                        }
                        toc.push({ level, text, slug });
                    }
                }
            }
        }

        const html = this.md.renderer.render(tokens, this.md.options, env);
        return { html, toc };
    }

    /** Returns highlighted inner HTML (no wrapping <pre><code>). */
    private highlightInner(str: string, language: string): string {
        return this.highlightMemberRoots(
            hljs.highlight(str, { language, ignoreIllegals: true }).value
        );
    }

    private highlightQuotedStrings(value: string): string {
        const pattern = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
        let html = '';
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(value)) !== null) {
            html += this.md.utils.escapeHtml(value.slice(lastIndex, match.index));
            html += `<span class="hljs-string">${this.md.utils.escapeHtml(match[0])}</span>`;
            lastIndex = pattern.lastIndex;
        }

        html += this.md.utils.escapeHtml(value.slice(lastIndex));
        return html;
    }

    private highlightMemberRoots(value: string): string {
        return value.replace(/(^|[^\w$>&])([A-Za-z_$][\w$]*)(\.)/g, '$1<span class="hljs-variable">$2</span>$3');
    }
}
