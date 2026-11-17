import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface TextPreviewPayload {
    fileName: string;
    ext: string;
    content: string;
    truncated: boolean;
    totalBytes: number;
}

export class PathResolver {
    private static readonly _base64Cache = new Map<string, { mtimeMs: number; dataUri: string }>();
    private static readonly _MAX_CACHE_ENTRIES = 64;
    private static readonly _IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
    private static readonly _TEXT_PREVIEW_EXT_REGEX = /\.(json|jsonl|txt|log|csv|tsv|yml|yaml|toml|ini|conf|xml|sql|md)$/i;
    private static readonly _BARE_EVIDENCE_FILE_REGEX = /(?<![A-Za-z0-9_./:-@])([A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5/-]{0,120}\.(?:png|jpe?g|gif|webp|svg|bmp|json|jsonl|txt|log|csv|tsv|yml|yaml|md))(?![A-Za-z0-9_./*-])/gi;
    private static readonly _CODE_SINGLE_FILE_REGEX = /^([A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5/-]{0,120}\.(?:png|jpe?g|gif|webp|svg|bmp|json|jsonl|txt|log|csv|tsv|yml|yaml|md))$/i;

    private static _escapeAttr(value: string): string {
        return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    public static stripQueryAndHash(raw: string): string {
        return raw.split('#')[0].split('?')[0];
    }

    public static safeDecodePath(raw: string): string {
        const cleaned = raw.trim();
        try {
            return decodeURIComponent(cleaned);
        } catch {
            return cleaned;
        }
    }

    public static isRemoteOrDataUri(rawUrl: string): boolean {
        const lower = rawUrl.trim().toLowerCase();
        return lower.startsWith('http://')
            || lower.startsWith('https://')
            || lower.startsWith('data:')
            || lower.startsWith('mailto:')
            || lower.startsWith('vscode:');
    }

    public static isImageFilePath(rawUrl: string): boolean {
        const trimmed = rawUrl.trim();
        if (!trimmed || trimmed.startsWith('#') || PathResolver.isRemoteOrDataUri(trimmed)) {
            return false;
        }
        const stripped = PathResolver.stripQueryAndHash(trimmed);
        return !stripped.includes('*') && PathResolver._IMAGE_EXT_REGEX.test(stripped);
    }

    public static isTextPreviewFilePath(rawUrl: string): boolean {
        const trimmed = rawUrl.trim();
        if (!trimmed || trimmed.startsWith('#') || PathResolver.isRemoteOrDataUri(trimmed)) {
            return false;
        }
        const stripped = PathResolver.stripQueryAndHash(trimmed);
        return !stripped.includes('*') && PathResolver._TEXT_PREVIEW_EXT_REGEX.test(stripped);
    }

    private static _getAllowedRoots(documentDir: string): string[] {
        return [
            path.resolve(documentDir) + path.sep,
            ...(vscode.workspace.workspaceFolders?.map(f => path.resolve(f.uri.fsPath) + path.sep) ?? [])
        ];
    }

    public static resolveCandidateFile(
        rawFilePath: string,
        documentDir: string,
        documentUri?: vscode.Uri
    ): string | null {
        const decoded = PathResolver.safeDecodePath(rawFilePath);
        const normalizedInput = decoded.startsWith('file://')
            ? vscode.Uri.parse(decoded).fsPath
            : decoded;

        const candidates: string[] = [];
        if (path.isAbsolute(normalizedInput)) {
            candidates.push(normalizedInput);
        } else {
            candidates.push(path.resolve(documentDir, normalizedInput));
            if (documentUri) {
                const wsFolder = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath;
                if (wsFolder) {
                    candidates.push(path.resolve(wsFolder, normalizedInput));
                }
            }
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                candidates.push(path.resolve(folder.uri.fsPath, normalizedInput));
            }
            let cur = documentDir;
            for (let i = 0; i < 4; i++) {
                const parent = path.dirname(cur);
                if (!parent || parent === cur) { break; }
                candidates.push(path.resolve(parent, normalizedInput));
                cur = parent;
            }
        }

        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (seen.has(candidate)) { continue; }
            seen.add(candidate);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch {
                // ignore unreadable candidate path
            }
        }
        return null;
    }

    private static _readAsDataUriCached(absolutePath: string): string | null {
        try {
            if (!fs.existsSync(absolutePath)) {
                return null;
            }
            const stat = fs.statSync(absolutePath);
            const cached = PathResolver._base64Cache.get(absolutePath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                return cached.dataUri;
            }

            const extension = path.extname(absolutePath).slice(1).toLowerCase();
            const mimeMap: Record<string, string> = {
                'jpg': 'jpeg',
                'jpeg': 'jpeg',
                'png': 'png',
                'gif': 'gif',
                'svg': 'svg+xml',
                'webp': 'webp'
            };
            const mime = mimeMap[extension] || extension;
            const base64 = fs.readFileSync(absolutePath).toString('base64');
            const dataUri = `data:image/${mime};base64,${base64}`;

            if (PathResolver._base64Cache.size >= PathResolver._MAX_CACHE_ENTRIES) {
                const oldestKey = PathResolver._base64Cache.keys().next().value;
                if (oldestKey) {
                    PathResolver._base64Cache.delete(oldestKey);
                }
            }
            PathResolver._base64Cache.set(absolutePath, { mtimeMs: stat.mtimeMs, dataUri });
            return dataUri;
        } catch (err) {
            console.error(`Failed to read image as data URI: ${absolutePath}`, err);
            return null;
        }
    }

    /**
     * Resolves relative image paths in markdown to data: URI (base64).
     * This is necessary for webview and static exports to display images correctly.
     */
    public static resolveImages(markdown: string, documentDir: string): string {
        // Regex to find markdown images: ![alt](url)
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

        return markdown.replace(imageRegex, (match, alt, imageUrl) => {
            // Skip absolute URLs
            if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:')) {
                return match;
            }

            try {
                const absolutePath = path.resolve(
                    path.isAbsolute(imageUrl) ? imageUrl : path.join(documentDir, imageUrl)
                );
                const dataUri = PathResolver._readAsDataUriCached(absolutePath);
                if (dataUri) {
                    return `![${alt}](${dataUri})`;
                }
            } catch (err) {
                console.error(`Failed to resolve image path: ${imageUrl}`, err);
            }

            return match;
        });
    }

    /**
     * Resolves relative image paths to webview-safe URIs. Falls back to cached base64
     * data URIs for images outside allowed localResourceRoots.
     */
    public static resolveImagesForWebview(
        markdown: string,
        documentDir: string,
        webview: vscode.Webview
    ): string {
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        const allowedRoots = PathResolver._getAllowedRoots(documentDir);

        return markdown.replace(imageRegex, (match, alt, imageUrl) => {
            if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:')) {
                return match;
            }

            try {
                const absolutePath = path.resolve(
                    path.isAbsolute(imageUrl) ? imageUrl : path.join(documentDir, imageUrl)
                );

                // If the image is within the document directory or any open workspace folder, use zero-I/O webview URI
                if (allowedRoots.some(root => absolutePath.startsWith(root))) {
                    const webviewUri = webview.asWebviewUri(vscode.Uri.file(absolutePath));
                    return `![${alt}](${webviewUri})`;
                }

                // Otherwise, fall back to mtime-cached base64 data URI to bypass localResourceRoots
                const dataUri = PathResolver._readAsDataUriCached(absolutePath);
                if (dataUri) {
                    return `![${alt}](${dataUri})`;
                }

                // File not found, try webview URI as last resort
                const webviewUri = webview.asWebviewUri(vscode.Uri.file(absolutePath));
                return `![${alt}](${webviewUri})`;
            } catch (err) {
                console.error(`Failed to resolve image path: ${imageUrl}`, err);
                return match;
            }
        });
    }

    /**
     * Backward-compatible alias for annotating local evidence links & bare filenames.
     */
    public static annotateImageLinksForWebview(
        html: string,
        documentDir: string,
        webview: vscode.Webview
    ): string {
        return PathResolver.annotateLocalEvidenceForWebview(html, documentDir, webview);
    }

    /**
     * Annotates local image & text/JSON evidence across:
     * 1. `<a href="...">` links (`data-folio-img-src` / `data-folio-data-preview="true"`)
     * 2. Existing inline `<code>file.ext</code>` and bare text filenames (`<span class="folio-bare-file">`)
     *    ONLY when the file genuinely exists on disk (0% false positive on hypothetical filenames).
     */
    public static annotateLocalEvidenceForWebview(
        html: string,
        documentDir: string,
        webview: vscode.Webview,
        documentUri?: vscode.Uri
    ): string {
        const allowedRoots = PathResolver._getAllowedRoots(documentDir);
        const candidateCache = new Map<string, string | null>();
        const resolveCached = (filePath: string): string | null => {
            if (!candidateCache.has(filePath)) {
                candidateCache.set(filePath, PathResolver.resolveCandidateFile(filePath, documentDir, documentUri));
            }
            return candidateCache.get(filePath) ?? null;
        };

        const buildWebviewImgSrc = (resolvedPath: string): string | null => {
            try {
                if (allowedRoots.some(root => resolvedPath.startsWith(root))) {
                    return PathResolver._escapeAttr(webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString());
                }
            } catch {
                // Fall back to on-demand data URI resolution in webview
            }
            return null;
        };

        const parts = html.split(/(<[^>]+>)/g);
        const out: string[] = [];
        let preDepth = 0;
        let aDepth = 0;
        let scriptStyleDepth = 0;
        let codeDepth = 0;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part) { continue; }

            if (part.startsWith('<')) {
                const lowerTag = part.toLowerCase();
                if (/^<pre(?:\s|>|$)/.test(lowerTag)) {
                    preDepth++;
                } else if (/^<\/pre(?:\s|>|$)/.test(lowerTag)) {
                    preDepth = Math.max(0, preDepth - 1);
                } else if (/^<(?:script|style)(?:\s|>|$)/.test(lowerTag)) {
                    scriptStyleDepth++;
                } else if (/^<\/(?:script|style)(?:\s|>|$)/.test(lowerTag)) {
                    scriptStyleDepth = Math.max(0, scriptStyleDepth - 1);
                } else if (/^<a(?:\s|>|$)/.test(lowerTag)) {
                    aDepth++;
                    const anchorMatch = part.match(/^<a\b([^>]*?)\bhref="([^"]+)"([^>]*)>$/i);
                    if (anchorMatch) {
                        const [, before, rawHref, after] = anchorMatch;
                        if (PathResolver.isImageFilePath(rawHref) && !before.includes('data-folio-img-src=') && !after.includes('data-folio-img-src=')) {
                            try {
                                const pathPart = PathResolver.safeDecodePath(PathResolver.stripQueryAndHash(rawHref));
                                const resolved = pathPart.startsWith('file://')
                                    ? vscode.Uri.parse(pathPart).fsPath
                                    : path.resolve(path.isAbsolute(pathPart) ? pathPart : path.join(documentDir, pathPart));
                                const src = buildWebviewImgSrc(resolved);
                                if (src) {
                                    out.push(`<a${before} href="${rawHref}" data-folio-img-src="${src}"${after}>`);
                                    continue;
                                }
                            } catch {
                                // ignore invalid URI
                            }
                        } else if (PathResolver.isTextPreviewFilePath(rawHref) && !before.includes('data-folio-data-preview=') && !after.includes('data-folio-data-preview=')) {
                            const pathPart = PathResolver.stripQueryAndHash(rawHref);
                            if (resolveCached(pathPart)) {
                                out.push(`<a${before} href="${rawHref}" data-folio-data-preview="true"${after}>`);
                                continue;
                            }
                        }
                    }
                    out.push(part);
                    continue;
                } else if (/^<\/a(?:\s|>|$)/.test(lowerTag)) {
                    aDepth = Math.max(0, aDepth - 1);
                } else if (/^<code(?:\s|>|$)/.test(lowerTag)) {
                    codeDepth++;
                    if (preDepth === 0 && aDepth === 0 && scriptStyleDepth === 0 && i + 2 < parts.length && /^<\/code\s*>$/i.test(parts[i + 2])) {
                        const innerText = parts[i + 1].trim();
                        const fileMatch = innerText.match(PathResolver._CODE_SINGLE_FILE_REGEX);
                        if (fileMatch) {
                            const fileName = fileMatch[1];
                            const resolved = resolveCached(fileName);
                            if (resolved) {
                                const attrRaw = PathResolver._escapeAttr(fileName);
                                if (PathResolver.isImageFilePath(fileName) && !lowerTag.includes('data-folio-evidence-kind=')) {
                                    const imgSrc = buildWebviewImgSrc(resolved);
                                    const imgSrcAttr = imgSrc ? ` data-folio-img-src="${imgSrc}"` : '';
                                    out.push(part.slice(0, -1) + ` data-folio-evidence-kind="image" data-folio-raw-href="${attrRaw}"${imgSrcAttr}>`);
                                    continue;
                                }
                                if (PathResolver.isTextPreviewFilePath(fileName) && !lowerTag.includes('data-folio-evidence-kind=')) {
                                    out.push(part.slice(0, -1) + ` data-folio-evidence-kind="data" data-folio-raw-href="${attrRaw}" data-folio-data-preview="true">`);
                                    continue;
                                }
                            }
                        }
                    }
                } else if (/^<\/code(?:\s|>|$)/.test(lowerTag)) {
                    codeDepth = Math.max(0, codeDepth - 1);
                }

                out.push(part);
                continue;
            }

            if (preDepth === 0 && aDepth === 0 && scriptStyleDepth === 0 && codeDepth === 0) {
                const replaced = part.replace(PathResolver._BARE_EVIDENCE_FILE_REGEX, (match, fileName: string) => {
                    const resolved = resolveCached(fileName);
                    if (!resolved) {
                        return match;
                    }
                    const attrRaw = PathResolver._escapeAttr(fileName);
                    if (PathResolver.isImageFilePath(fileName)) {
                        const imgSrc = buildWebviewImgSrc(resolved);
                        const imgSrcAttr = imgSrc ? ` data-folio-img-src="${imgSrc}"` : '';
                        return `<span class="folio-bare-file" data-folio-evidence-kind="image" data-folio-raw-href="${attrRaw}"${imgSrcAttr}>${match}</span>`;
                    }
                    if (PathResolver.isTextPreviewFilePath(fileName)) {
                        return `<span class="folio-bare-file" data-folio-evidence-kind="data" data-folio-raw-href="${attrRaw}" data-folio-data-preview="true">${match}</span>`;
                    }
                    return match;
                });
                out.push(replaced);
                continue;
            }

            out.push(part);
        }

        return out.join('');
    }

    public static readTextPreviewForLink(
        rawHref: string,
        documentDir: string,
        documentUri?: vscode.Uri
    ): TextPreviewPayload | null {
        const MAX_BYTES = 49152;
        const MAX_LINES = 160;

        const pathPart = PathResolver.stripQueryAndHash(rawHref);
        if (!PathResolver.isTextPreviewFilePath(pathPart)) {
            return null;
        }
        const resolved = PathResolver.resolveCandidateFile(pathPart, documentDir, documentUri);
        if (!resolved) {
            return null;
        }

        let fd: number | null = null;
        try {
            const stat = fs.statSync(resolved);
            const totalBytes = stat.size;
            const toRead = Math.min(totalBytes, MAX_BYTES);
            const buf = Buffer.alloc(toRead);
            fd = fs.openSync(resolved, 'r');
            const bytesRead = toRead > 0 ? fs.readSync(fd, buf, 0, toRead, 0) : 0;

            // Reject binary content if NUL byte found in header bytes
            const inspectLen = Math.min(bytesRead, 4096);
            if (buf.subarray(0, inspectLen).includes(0)) {
                return null;
            }

            let content = buf.toString('utf8', 0, bytesRead);
            let truncated = totalBytes > bytesRead;
            const ext = path.extname(resolved).toLowerCase().replace(/^\./, '') || 'txt';

            if (ext === 'json' && !truncated) {
                try {
                    const parsed = JSON.parse(content);
                    content = JSON.stringify(parsed, null, 2);
                } catch {
                    // keep original JSON text when malformed
                }
            }

            const lines = content.split(/\r?\n/);
            if (lines.length > MAX_LINES) {
                content = lines.slice(0, MAX_LINES).join('\n');
                truncated = true;
            }

            return {
                fileName: path.basename(resolved),
                ext,
                content,
                truncated,
                totalBytes,
            };
        } catch {
            return null;
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore close error */ }
            }
        }
    }

    public static readImageDataUriForLink(
        rawHref: string,
        documentDir: string,
        documentUri?: vscode.Uri
    ): string | null {
        const pathPart = PathResolver.stripQueryAndHash(rawHref);
        if (!PathResolver.isImageFilePath(pathPart)) {
            return null;
        }
        const resolved = PathResolver.resolveCandidateFile(pathPart, documentDir, documentUri);
        if (!resolved) {
            return null;
        }
        return PathResolver._readAsDataUriCached(resolved);
    }
}
