import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PathResolver {
    private static readonly _base64Cache = new Map<string, { mtimeMs: number; dataUri: string }>();
    private static readonly _MAX_CACHE_ENTRIES = 64;
    private static readonly _IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

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
        return PathResolver._IMAGE_EXT_REGEX.test(PathResolver.stripQueryAndHash(trimmed));
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
     * Attaches zero-I/O webview URIs via `data-folio-img-src` on local image links (`<a href="*.png">`)
     * so Lightbox and inline thumbnail cards can render them without mutating original hrefs.
     */
    public static annotateImageLinksForWebview(
        html: string,
        documentDir: string,
        webview: vscode.Webview
    ): string {
        const allowedRoots = PathResolver._getAllowedRoots(documentDir);
        const anchorRegex = /<a\b([^>]*?)\bhref="([^"]+)"([^>]*)>/gi;

        return html.replace(anchorRegex, (match, before: string, rawHref: string, after: string) => {
            if (!PathResolver.isImageFilePath(rawHref)) {
                return match;
            }
            if (before.includes('data-folio-img-src=') || after.includes('data-folio-img-src=')) {
                return match;
            }

            try {
                const pathPart = PathResolver.safeDecodePath(PathResolver.stripQueryAndHash(rawHref));
                const resolved = pathPart.startsWith('file://')
                    ? vscode.Uri.parse(pathPart).fsPath
                    : path.resolve(path.isAbsolute(pathPart) ? pathPart : path.join(documentDir, pathPart));

                if (allowedRoots.some(root => resolved.startsWith(root))) {
                    const webviewUri = webview.asWebviewUri(vscode.Uri.file(resolved)).toString()
                        .replace(/&/g, '&amp;')
                        .replace(/"/g, '&quot;');
                    return `<a${before} href="${rawHref}" data-folio-img-src="${webviewUri}"${after}>`;
                }
            } catch {
                // Fall back to on-demand RPC resolution in webview
            }
            return match;
        });
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
