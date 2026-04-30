import * as fs from 'fs';
import * as path from 'path';
import { TocItem } from './shared/types';

export interface PdfSettings {
    headingFont?: string;
    bodyFont?: string;
    fontSize?: number;
    headingSize?: 'S' | 'M' | 'L';
    lineSpacing?: string;
    pageWidth?: 'narrow' | 'standard' | 'wide';
    showToolbar?: boolean;
    showTocSidebar?: boolean;
    theme?: 'admiral' | 'ivory' | 'serene' | 'cyberpunk' | 'dracula' | 'github' | 'zen';
}

export interface ExportHtmlOptions {
    compactPaper?: boolean;
}

export class HtmlBuilder {
    /**
     * Tạo HTML self-contained cho PDF.
     * Đọc document.pdf.css từ distDir và inject inline.
     * CSS variables được override theo settings người dùng.
     */
    static buildPdfHtml(params: {
        html: string;
        distDir: string;
        settings?: PdfSettings;
        title?: string;
    }): string {
        const { html, distDir, settings, title } = params;

        // Đọc PDF stylesheet (mirrors preview light-mode visual)
        const pdfCss = HtmlBuilder._readDistOrSourceCss(distDir, 'document.pdf.css');

        // Đọc KaTeX CSS
        const katexCssPath = path.join(distDir, 'katex.css');
        const katexCss = fs.existsSync(katexCssPath)
            ? fs.readFileSync(katexCssPath, 'utf-8')
            : '';

        const themeCss = HtmlBuilder._readDistOrSourceCss(distDir, 'theme.css');

        const themeClass = HtmlBuilder._themeClass(settings?.theme);
        const themeOverrides = HtmlBuilder._buildPdfThemeOverrides(themeCss, settings?.theme);

        // Inject settings overrides
        const settingsOverrides = HtmlBuilder._buildSettingsOverrides(settings, true);

        // base href giúp relative URL trong katex.css (fonts/) resolve đúng từ distDir
        const baseHref = distDir.replace(/\\/g, '/');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title ? title.replace(/</g, '&lt;') : 'Document'}</title>
    <base href="file:///${baseHref}/">
    <style>${pdfCss}</style>
    ${themeOverrides ? `<style>${themeOverrides}</style>` : ''}
    <style>${katexCss}</style>
    ${settingsOverrides ? `<style>${settingsOverrides}</style>` : ''}
</head>
<body class="${themeClass}">
    <div id="document-content">${html}</div>
    <script src="mermaid.min.js"><\/script>
    <script>
        (function() {
            // Convert <code class="language-mermaid"> blocks to <div class="mermaid">
            document.querySelectorAll('code.language-mermaid').forEach(function(el) {
                var div = document.createElement('div');
                div.className = 'mermaid';
                div.textContent = el.textContent;
                var pre = el.closest('pre');
                if (pre) { pre.replaceWith(div); } else { el.replaceWith(div); }
            });
            window._mermaidDone = false;
                mermaid.initialize({ startOnLoad: false, theme: ${HtmlBuilder._isDarkTheme(settings?.theme) ? "'dark'" : "'default'"}, securityLevel: 'loose' });
            mermaid.run({ querySelector: '.mermaid' }).then(function() {
                window._mermaidDone = true;
            }).catch(function() {
                window._mermaidDone = true;
            });
        })();
    <\/script>
</body>
</html>`;
    }

    /**
     * Tạo HTML self-contained cho HTML export (chia sẻ).
     * Visual giống preview: dark/light background + A4 paper card.
     * Fonts từ Google Fonts CDN. KaTeX fonts inline base64. Mermaid CDN.
     */
    static buildExportHtml(params: {
        html: string;
        distDir: string;
        settings?: PdfSettings;
        title?: string;
        toc?: TocItem[];
        exportOptions?: ExportHtmlOptions;
    }): string {
        const { html, distDir, settings, title, toc = [], exportOptions } = params;

        const themeCss = HtmlBuilder._readDistOrSourceCss(distDir, 'theme.css');
        const documentCss = HtmlBuilder._readDistOrSourceCss(distDir, 'document.css');
        const sidebarCss = HtmlBuilder._readDistOrSourceCss(distDir, 'sidebar.css');

        // Đọc KaTeX CSS và inline fonts base64
        let katexCss = fs.existsSync(path.join(distDir, 'katex.css'))
            ? fs.readFileSync(path.join(distDir, 'katex.css'), 'utf-8') : '';
        katexCss = HtmlBuilder._inlineFontUrls(katexCss, distDir, /url\((fonts\/[^)]+)\)/g);

        const settingsOverrides = HtmlBuilder._buildSettingsOverrides(settings, false);
        const bodyClass = HtmlBuilder._themeClass(settings?.theme);
        const sidebarHtml = settings?.showTocSidebar === false ? '' : HtmlBuilder._buildTocHtml(toc);
        const pageWidth = settings?.pageWidth || 'standard';
        const bodyClasses = [
            bodyClass,
            exportOptions?.compactPaper ? 'export-compact-paper' : '',
        ].filter(Boolean).join(' ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title ? title.replace(/</g, '&lt;') : 'Document'}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&family=Merriweather:wght@400;700&display=swap">
    <style>${themeCss}</style>
    <style>${documentCss}</style>
    <style>${sidebarCss}</style>
    <style>${katexCss}</style>
    ${settingsOverrides ? `<style>${settingsOverrides}</style>` : ''}
    <style>
        #document-container { padding-top: 32px; min-height: 100vh; }
        body.export-compact-paper #document-paper { min-height: 0; }
        #sidebar-toc a { color: inherit; text-decoration: none; display: block; }
    </style>
</head>
<body class="${bodyClasses}">
    <div class="workspace-shell">
        ${sidebarHtml ? `<aside id="sidebar-toc">${sidebarHtml}</aside>` : ''}
        <main id="document-container">
            <div id="document-paper" class="width-${pageWidth}">
                <div id="document-content">${html}</div>
            </div>
        </main>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <script>
        (function() {
            window._mermaidDone = false;
            document.querySelectorAll('code.language-mermaid').forEach(function(el) {
                var div = document.createElement('div');
                div.className = 'mermaid';
                div.textContent = el.textContent;
                var pre = el.closest('pre');
                if (pre) { pre.replaceWith(div); } else { el.replaceWith(div); }
            });
            mermaid.initialize({ startOnLoad: true, theme: ${HtmlBuilder._isDarkTheme(settings?.theme) ? "'dark'" : "'default'"}, securityLevel: 'loose' });
            mermaid.run({ querySelector: '.mermaid' }).then(function() {
                window._mermaidDone = true;
            }).catch(function() {
                window._mermaidDone = true;
            });
        })();
    </script>
</body>
</html>`;
    }

    private static _readDistOrSourceCss(distDir: string, fileName: string): string {
        const distPath = path.join(distDir, fileName);
        if (fs.existsSync(distPath)) {
            return fs.readFileSync(distPath, 'utf-8');
        }

        const sourcePath = path.join(distDir, '..', 'webview', 'styles', fileName);
        if (fs.existsSync(sourcePath)) {
            return fs.readFileSync(sourcePath, 'utf-8');
        }

        return '';
    }

    private static _themeClass(theme?: PdfSettings['theme']): string {
        return `${theme || 'ivory'}-mode`;
    }

    private static _isDarkTheme(theme?: PdfSettings['theme']): boolean {
        return !['ivory', 'serene', 'github', 'zen'].includes(theme || 'ivory');
    }

    private static _buildPdfThemeOverrides(themeCss: string, theme?: PdfSettings['theme']): string {
        const themeName = theme || 'ivory';
        const match = new RegExp(`body\\.${themeName}-mode\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(themeCss);
        if (!match) { return ''; }

        const vars = match[1]
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('--'))
            .join('\n');

        if (themeName === 'zen') {
            return `
body.zen-mode {
${vars}
    color: var(--text-primary);
    background: #ffffff;
}
body.zen-mode #document-content {
    color: var(--text-primary);
    font-family: var(--font-body);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
}
body.zen-mode h1,
body.zen-mode h2,
body.zen-mode h3,
body.zen-mode h4,
body.zen-mode h5,
body.zen-mode h6 {
    color: var(--gold-color);
    font-family: var(--font-heading);
    font-weight: 600;
    line-height: 1.3;
    border-bottom: none;
}
body.zen-mode h1,
body.zen-mode h2 {
    border-bottom: 1px solid rgba(44, 62, 80, 0.48);
    padding-bottom: 0.24em;
}
body.zen-mode h1 {
    font-size: 22pt;
    margin-top: 0;
    margin-bottom: 0.75rem;
}
body.zen-mode h2 {
    font-size: 17pt;
    margin-top: 2.2rem;
    margin-bottom: 0.7rem;
}
body.zen-mode h3,
body.zen-mode h4,
body.zen-mode h5,
body.zen-mode h6 {
    font-size: 13pt;
    margin-top: 1.8rem;
    margin-bottom: 0.55rem;
}
body.zen-mode a {
    color: var(--accent-color);
    text-decoration: none;
    font-weight: 600;
}
body.zen-mode p {
    margin: 1.2em 0;
}
body.zen-mode blockquote {
    border-left: 4px solid var(--accent-color);
    background: var(--quote-bg);
    color: #5c5c5c;
    padding: 0.1rem 1rem;
    margin: 0.9em 0;
    border-radius: 2px;
}
body.zen-mode blockquote p {
    margin: 0;
    padding: 1px 0;
    line-height: 1.45;
}
body.zen-mode pre {
    border: none;
    border-radius: 4px;
    padding: 10px 16px;
    background: var(--code-bg);
    margin: 0.75em 0;
    font-family: var(--font-mono);
}
body.zen-mode pre code {
    background: transparent;
    padding: 0;
    border-radius: 0;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 9pt;
    line-height: 1.55;
}
body.zen-mode .hljs-keyword,
body.zen-mode .hljs-selector-tag,
body.zen-mode .hljs-literal,
body.zen-mode .hljs-section,
body.zen-mode .hljs-link,
body.zen-mode .hljs-bullet,
body.zen-mode .hljs-subst,
body.zen-mode .hljs-meta,
body.zen-mode .hljs-symbol,
body.zen-mode .hljs-attribute {
    color: var(--syntax-keyword);
}
body.zen-mode .hljs-string,
body.zen-mode .hljs-doctag,
body.zen-mode .hljs-regexp {
    color: var(--syntax-string);
}
body.zen-mode .hljs-title,
body.zen-mode .hljs-name,
body.zen-mode .hljs-selector-id,
body.zen-mode .hljs-selector-class {
    color: var(--syntax-function);
}
body.zen-mode .hljs-variable,
body.zen-mode .hljs-template-variable,
body.zen-mode .hljs-params,
body.zen-mode .hljs-punctuation,
body.zen-mode .hljs-operator {
    color: var(--syntax-variable);
}
body.zen-mode .hljs-comment,
body.zen-mode .hljs-quote,
body.zen-mode .hljs-deletion {
    color: var(--syntax-comment);
    font-style: italic;
}
body.zen-mode .hljs-type,
body.zen-mode .hljs-built_in,
body.zen-mode .hljs-number,
body.zen-mode .hljs-addition {
    color: var(--syntax-constant);
}
body.zen-mode .hljs-attr,
body.zen-mode .hljs-property {
    color: var(--syntax-class);
}
body.zen-mode code {
    background: var(--code-bg);
    padding: 2px 5px;
    margin: 0 2px;
    border-radius: 2px;
    color: #e96900;
    font-family: var(--font-mono);
    font-size: 9pt;
    font-weight: 400;
    font-synthesis: none;
    white-space: pre-wrap;
}
body.zen-mode table th,
body.zen-mode table td {
    border: 1px solid #ddd;
    padding: 6px 13px;
}
body.zen-mode table tr:nth-child(even) {
    background: #f8f8f8;
}
body.zen-mode th {
    background: #f8f8f8;
    color: var(--gold-color);
}
body.zen-mode ul,
body.zen-mode ol {
    line-height: 1.6rem;
    margin: 0.6em 0 0.6em 1.5em;
}
body.zen-mode li {
    margin-bottom: 0.25em;
}
body.zen-mode hr {
    border: none;
    border-top: 1px solid #666;
    margin: 1.2em 0;
    opacity: 0.3;
}
body.zen-mode em {
    color: var(--text-muted);
}`;
        }

        return `
body.${themeName}-mode {
${vars}
    color: #111827;
    background: #ffffff;
    --text-primary: #111827;
    --text-muted: #4b5563;
    --page-bg: #ffffff;
    --app-bg: #ffffff;
    --app-bg-glow-1: rgba(0, 0, 0, 0);
    --app-bg-glow-2: rgba(0, 0, 0, 0);
    --code-bg: rgba(0, 0, 0, 0.05);
    --quote-bg: rgba(0, 0, 0, 0.04);
    --table-th-bg: rgba(0, 0, 0, 0.06);
    --table-tr-bg: rgba(0, 0, 0, 0.02);
    --border-color: rgba(0, 0, 0, 0.14);
    ${themeName === 'dracula' ? '--gold-color: #7c3aed;' : ''}
}
body.${themeName}-mode #document-content {
    color: var(--text-primary);
    font-family: var(--font-body);
}
body.${themeName}-mode h1,
body.${themeName}-mode h2 {
    color: var(--gold-color);
}
body.${themeName}-mode h1 {
    border-bottom-color: color-mix(in oklab, var(--gold-color) 32%, transparent);
}
body.${themeName}-mode h3,
body.${themeName}-mode h4,
body.${themeName}-mode h5,
body.${themeName}-mode h6 {
    color: var(--text-primary);
}
body.${themeName}-mode a {
    color: var(--accent-color);
}
body.${themeName}-mode blockquote {
    border-left-color: color-mix(in oklab, var(--gold-color) 60%, transparent);
    color: var(--text-muted);
    background: var(--quote-bg);
}
body.${themeName}-mode pre {
    background: var(--code-bg);
    border-color: var(--border-color);
}
body.${themeName}-mode code {
    background: var(--code-bg);
    color: var(--gold-color);
}
body.${themeName}-mode th,
body.${themeName}-mode td {
    border-color: var(--border-color);
}
body.${themeName}-mode th {
    background: var(--table-th-bg);
    color: var(--table-th-color, var(--gold-color));
}
body.${themeName}-mode tr:nth-child(even) {
    background: var(--table-tr-bg);
}
body.${themeName}-mode hr {
    border-top-color: var(--border-color);
}`;
    }

    private static _buildTocHtml(toc: TocItem[]): string {
        if (toc.length === 0) { return ''; }
        const items = toc.map(item => {
            const text = item.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="toc-item level-${item.level}"><a href="#${item.slug}">${text}</a></div>`;
        }).join('\n');
        return `<div class="toc-header">Contents</div>\n${items}`;
    }

    private static _inlineFontUrls(css: string, distDir: string, pattern: RegExp): string {
        const mimeMap: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
        return css.replace(pattern, (_match, relativePath) => {
            const fontPath = path.join(distDir, relativePath);
            if (!fs.existsSync(fontPath)) { return _match; }
            const ext = path.extname(fontPath).slice(1).toLowerCase();
            const mime = mimeMap[ext] || 'font/woff2';
            const b64 = fs.readFileSync(fontPath).toString('base64');
            return `url('data:${mime};base64,${b64}')`;
        });
    }

    private static _buildSettingsOverrides(settings?: PdfSettings, usePt = true): string {
        if (!settings) { return ''; }

        const lines: string[] = [];
        const themeControlsFonts = settings.theme === 'zen';

        if (settings.headingFont && !themeControlsFonts) {
            lines.push(`h1, h3, h4, h5, h6 { font-family: ${settings.headingFont}, Georgia, serif; }`);
        }
        if (settings.headingSize) {
            const hMap: Record<string, [string, string, string]> = usePt
                ? { S: ['18pt', '14pt', '11pt'], M: ['22pt', '17pt', '13pt'], L: ['28pt', '21pt', '16pt'] }
                : { S: ['1.6rem', '1.2rem', '1.0rem'], M: ['2rem', '1.46rem', '1.22rem'], L: ['2.5rem', '1.8rem', '1.5rem'] };
            const [h1, h2, h3] = hMap[settings.headingSize] ?? hMap['M'];
            lines.push(`h1 { font-size: ${h1}; } h2 { font-size: ${h2}; } h3, h4, h5, h6 { font-size: ${h3}; }`);
        }
        if (settings.bodyFont && !themeControlsFonts) {
            lines.push(`body, #document-content { font-family: ${settings.bodyFont}, 'Segoe UI', system-ui, sans-serif; }`);
        }
        if (settings.fontSize) {
            if (usePt) {
                // settings.fontSize là px, PDF cần pt: 1px = 0.75pt (tại 96dpi)
                const pt = (settings.fontSize * 0.75).toFixed(1);
                lines.push(`body { font-size: ${pt}pt; }`);
            } else {
                lines.push(`body { font-size: ${settings.fontSize}px; }`);
            }
        }
        if (settings.lineSpacing) {
            const lineHeightMap: Record<string, string> = { compact: '1.5', normal: '1.72', relaxed: '2.0' };
            const lh = lineHeightMap[settings.lineSpacing] ?? '1.72';
            lines.push(`body { line-height: ${lh}; }`);
        }

        return lines.join('\n');
    }

    /**
     * Build HTML snippet for copying to clipboard.
     * V1 just returns the wrapped rendered HTML without inlining CSS.
     */
    static buildClipboardHtmlSnippet(params: { html: string }): string {
        return `<div class="markdown-folio-content">
${params.html}
</div>`;
    }
}
