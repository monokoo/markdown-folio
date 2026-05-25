import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PathResolver {
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
                const absolutePath = path.isAbsolute(imageUrl)
                    ? imageUrl
                    : path.join(documentDir, imageUrl);

                if (fs.existsSync(absolutePath)) {
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
                    const content = fs.readFileSync(absolutePath);
                    const base64 = content.toString('base64');
                    return `![${alt}](data:image/${mime};base64,${base64})`;
                }
            } catch (err) {
                console.error(`Failed to resolve image path: ${imageUrl}`, err);
            }

            return match;
        });
    }

    /**
     * Resolves relative image paths to webview-safe URIs. Falls back to base64
     * data URIs for images outside the document directory (e.g. ../../img.svg)
     * to bypass localResourceRoots restrictions.
     */
    public static resolveImagesForWebview(
        markdown: string,
        documentDir: string,
        webview: vscode.Webview
    ): string {
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        const normalizedDocDir = path.resolve(documentDir) + path.sep;

        return markdown.replace(imageRegex, (match, alt, imageUrl) => {
            if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:')) {
                return match;
            }

            try {
                const absolutePath = path.resolve(
                    path.isAbsolute(imageUrl) ? imageUrl : path.join(documentDir, imageUrl)
                );

                // If the image is within the document directory, use webview URI
                if (absolutePath.startsWith(normalizedDocDir)) {
                    const webviewUri = webview.asWebviewUri(vscode.Uri.file(absolutePath));
                    return `![${alt}](${webviewUri})`;
                }

                // Otherwise, fall back to base64 data URI to bypass localResourceRoots
                if (fs.existsSync(absolutePath)) {
                    const extension = path.extname(absolutePath).slice(1).toLowerCase();
                    const mimeMap: Record<string, string> = {
                        'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png',
                        'gif': 'gif', 'svg': 'svg+xml', 'webp': 'webp'
                    };
                    const mime = mimeMap[extension] || extension;
                    const base64 = fs.readFileSync(absolutePath).toString('base64');
                    return `![${alt}](data:image/${mime};base64,${base64})`;
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
