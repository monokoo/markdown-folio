import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PathResolver {
    private static readonly _base64Cache = new Map<string, { mtimeMs: number; dataUri: string }>();
    private static readonly _MAX_CACHE_ENTRIES = 64;

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
        const allowedRoots = [
            path.resolve(documentDir) + path.sep,
            ...(vscode.workspace.workspaceFolders?.map(f => path.resolve(f.uri.fsPath) + path.sep) ?? [])
        ];

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
}
