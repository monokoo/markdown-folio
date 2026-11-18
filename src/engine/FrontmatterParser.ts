export class FrontmatterParser {
    private static readonly _TOP_LEVEL_KEY_RE =
        /^[A-Za-z0-9_.\u4e00-\u9fa5"-][A-Za-z0-9_.\u4e00-\u9fa5" -]{0,63}:(?:\s.*|$)/;
    private static readonly _BLOCK_SCALAR_OPENER_RE =
        /:\s*[|>](?:[-+]?\d*|\d[-+]?)?\s*(?:#.*)?$/;

    /**
     * Validates whether the candidate body between leading `---` fences is genuine YAML frontmatter
     * rather than a Markdown section bounded by CommonMark horizontal rules.
     */
    public static isValidYamlFrontmatter(yamlBody: string): boolean {
        const lines = yamlBody.split(/\r?\n/);
        if (lines.length === 0 || lines[0].trim() === '') {
            return false;
        }

        let topLevelKeyCount = 0;
        let prevWasBareKey = false;
        let inBlockScalarIndent: number | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            if (inBlockScalarIndent !== null) {
                if (trimmed === '') {
                    continue;
                }
                const indentMatch = line.match(/^[ \t]*/);
                const indent = indentMatch ? indentMatch[0].length : 0;
                if (indent > inBlockScalarIndent) {
                    continue;
                }
                inBlockScalarIndent = null;
            }

            // Reject Markdown ATX headings (H2-H6) outright
            if (/^#{2,6}(?:\s|$)/.test(line)) {
                return false;
            }

            // Allow YAML comments starting with '#'; standalone H1 without key: lines still fails topLevelKeyCount >= 1
            if (/^#/.test(line)) {
                continue;
            }

            if (trimmed === '') {
                if (topLevelKeyCount < 1) {
                    return false;
                }
                continue;
            }

            if (/^[ \t]+\S/.test(line)) {
                if (topLevelKeyCount < 1) {
                    return false;
                }
                prevWasBareKey = false;
                if (
                    FrontmatterParser._TOP_LEVEL_KEY_RE.test(trimmed) &&
                    FrontmatterParser._BLOCK_SCALAR_OPENER_RE.test(trimmed)
                ) {
                    const indentMatch = line.match(/^[ \t]*/);
                    inBlockScalarIndent = indentMatch ? indentMatch[0].length : 0;
                }
                continue;
            }

            if (/^-\s+/.test(line)) {
                if (!prevWasBareKey) {
                    return false;
                }
                continue;
            }

            if (/^\d+\.\s/.test(line)) {
                return false;
            }

            if (FrontmatterParser._TOP_LEVEL_KEY_RE.test(line)) {
                topLevelKeyCount++;
                if (FrontmatterParser._BLOCK_SCALAR_OPENER_RE.test(line)) {
                    inBlockScalarIndent = 0;
                    prevWasBareKey = false;
                } else {
                    prevWasBareKey = /:\s*(?:#.*)?$/.test(line);
                }
                continue;
            }

            return false;
        }

        return topLevelKeyCount >= 1;
    }

    /**
     * Extracts title, author, and date from YAML front matter.
     * Returns lineOffset = number of lines consumed by the frontmatter block.
     */
    public static extract(markdownContent: string): {
        title?: string;
        author?: string;
        date?: string;
        content: string;
        lineOffset: number;
    } {
        // Capture frontmatter block (match[1]), YAML body (match[2]), and remainder (match[3]) separately
        // so we can count newlines in only the stripped prefix — NOT the whole document.
        const frontmatterRegex = /^(---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/;
        const match = markdownContent.match(frontmatterRegex);

        if (match && FrontmatterParser.isValidYamlFrontmatter(match[2])) {
            const frontmatterBlock = match[1]; // e.g. "---\ntitle: Foo\n---\n"
            const yaml = match[2];
            const content = match[3];

            const titleMatch = yaml.match(/^title:\s*(.*)$/m);
            const authorMatch = yaml.match(/^author:\s*(.*)$/m);
            const dateMatch = yaml.match(/^date:\s*(.*)$/m);

            // Count newlines in the stripped prefix to get correct line offset
            const lineOffset = (frontmatterBlock.match(/\n/g) || []).length;

            return {
                title: titleMatch ? titleMatch[1].replace(/['"]/g, '').trim() : undefined,
                author: authorMatch ? authorMatch[1].replace(/['"]/g, '').trim() : undefined,
                date: dateMatch ? dateMatch[1].replace(/['"]/g, '').trim() : undefined,
                content,
                lineOffset,
            };
        }

        return { content: markdownContent, lineOffset: 0 };
    }
}
