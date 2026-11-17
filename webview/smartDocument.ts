const REPORT_CONTEXT_RE = /(?:环境|染色|项目\s*\d+|用例\s*\d+|SPU|DJob|Trace|核验日期|截至\s*20\d{2}|目标代码|(?:通过|未通过|失败|跳过|已上线|精确回绑))/i;
const KPI_CLAUSE_SPLIT_RE = /[，。；：、\n]/;
const KPI_MEASURE_RE = /(?:^|[^\d.])(\d{1,4})\s*(个|条|项|场景)([^\d，。；：（）()\n]{0,18})/g;
const KPI_PREFIX_IGNORE_RE = /(?:项目|模块|单号|工单|任务|步骤|ID|规则|[A-Za-z]+Job|[A-Za-z]+Space|共?\d+步)\s*$/i;
const KPI_VALID_KEYWORD_RE = /(?:独立商品|场景|通过|未通过|失败|缺陷|跳过|已上传|已上线|精确回绑|待校验|未完成|本地用例|修订|草稿|候选|原场景|直接变更)/;
const KPI_FAIL_TONE_RE = /(?:未通过|失败|缺陷|未上线|未完成|未受理|未覆盖)/;
const KPI_WARN_TONE_RE = /(?:跳过|待校验|待核|未回绑|草稿)/;
const KPI_PASS_TONE_RE = /(?:通过|已上线|精确回绑|已上传)/;

const KV_LINE_START_RE = /^([A-Za-z0-9\u4e00-\u9fa5_/-]{2,15})(：|:\s+)(.+)$/;
const KV_AFTER_NEWLINE_RE = /\n([A-Za-z0-9\u4e00-\u9fa5_/-]{2,15})(：|:\s+)/g;
const LI_LEAD_KEY_RE = /^([^：:\n]{2,16})(：|:\s+)/;
const CLOCK_OR_URL_RE = /^(?:https?:\/\/|\d{1,2}:\d{2})/i;

const DEFECT_HEADING_RE = /(?:已确认.*(?:缺陷|问题|Bug)|保留缺陷|未完成|阻塞)/i;
const DEFECT_STRONG_RE = /(?:没有标红|未标红|未通过|失败|缺陷|颠倒|相反|阻塞|未完成)/;
const AUTO_FOLD_HEADING_RE = /(?:非业务问题|临时配置恢复|配置恢复回执|历史变更记录|^附录)/;
const ROW_KV_PAIR_RE = /\b([A-Za-z0-9_-]{1,12})=([A-Za-z0-9_-]{2,24})\b/g;

const GFM_ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?(?:\n|$)/i;
const STATUS_PASS_RE = /^(?:PASS(?:ED)?|SUCCESS|OK|通过|已通过|两轮通过[／/]已上传|已上线[，,]精确回绑已确认|已更新[，,]在线)$/i;
const STATUS_FAIL_RE = /^(?:FAIL(?:ED|_[A-Z0-9_]+)?|ERROR|TIMEOUT|未通过|失败|依赖失败|未通过[／/]当前未上传|未上线[：:].+|.+失败[，,]修订未发布)$/i;
const STATUS_SKIP_RE = /^(?:SKIP(?:PED)?|WARN(?:ING)?|BLOCKED|PENDING|跳过|待创建|待核|业务锁争用[，,]待核|已更新[，,]未上线|.+前提未满足[，,]修订未发布|已上线[，,](?:精确绑定关系未确认|模块无对应叶子))$/i;

const EXACT_RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const EXACT_HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const INLINE_RGB_GLOBAL_RE = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/gi;
const BARE_HEX_HASH_RE = /(?<![0-9A-Za-z_./:-])([0-9a-f]{32,64})(?![0-9A-Za-z_./:-])/gi;
const BARE_TECH_TOKEN_RE = /(?<![A-Za-z0-9_./:?&-])(?:(?:CE_)?c-t\d+-[A-Za-z0-9_.-]+|(?:origin\/)?(?:hotfix|feature|release)-[A-Za-z0-9_./-]+|AUTOCASE[A-Za-z0-9_<>-]+|batch_\d{8}-[A-Za-z0-9_-]+|report_[0-9a-f]{12,24}|interface-[0-9a-f]{16,24}|\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){2,}|[A-Z][A-Za-z0-9]+Api\/[a-zA-Z0-9_]+|[a-z][A-Za-z0-9_]{2,28}=(?:true|false|passed|failed|null|[0-9]{1,8})|(?:[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+|passed_confirmed|DISPATCHED))(?![A-Za-z0-9_./:-])/g;

const GFM_ALERT_TITLES: Record<string, string> = {
    note: 'NOTE',
    tip: 'TIP',
    important: 'IMPORTANT',
    warning: 'WARNING',
    caution: 'CAUTION',
};

interface KpiItem {
    value: string;
    label: string;
    tone: 'pass' | 'fail' | 'warn' | 'neutral';
}

interface TextMatchSpan {
    start: number;
    end: number;
    kind: 'rgb' | 'hash' | 'token';
    text: string;
    cssColor?: string;
}

function isValidRgbChannels(r: string, g: string, b: string): boolean {
    return Number(r) <= 255 && Number(g) <= 255 && Number(b) <= 255;
}

function getFirstSignificantTextNode(el: Element): Text | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || parent.closest('.folio-restructure-only, .folio-image-expand-btn, .folio-data-expand-btn')) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!(node.nodeValue ?? '').trim()) {
                return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    return (walker.nextNode() as Text | null);
}

function extractReportKpis(paragraphs: HTMLParagraphElement[]): KpiItem[] {
    const combined = paragraphs.map(p => (p.textContent ?? '').trim()).join('\n');
    if (!REPORT_CONTEXT_RE.test(combined)) {
        return [];
    }

    const items: KpiItem[] = [];
    const seenLabels = new Set<string>();
    const clauses = combined.split(KPI_CLAUSE_SPLIT_RE);

    for (const rawClause of clauses) {
        const clause = rawClause.trim();
        if (!clause || clause.length > 64) { continue; }
        if (/专属\s*Mock/i.test(clause)) { continue; }

        KPI_MEASURE_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = KPI_MEASURE_RE.exec(clause)) !== null) {
            const numStr = match[1];
            const unit = match[2];
            const tail = (match[3] ?? '').trim();
            const matchIdx = match.index + (match[0].indexOf(numStr));
            const prefix = clause.slice(0, matchIdx);
            if (KPI_PREFIX_IGNORE_RE.test(prefix)) { continue; }

            const localContext = (prefix.slice(-10) + numStr + unit + tail).trim();
            if (!KPI_VALID_KEYWORD_RE.test(localContext)) { continue; }

            let tone: KpiItem['tone'] = 'neutral';
            if (KPI_FAIL_TONE_RE.test(localContext)) {
                tone = 'fail';
            } else if (KPI_WARN_TONE_RE.test(localContext)) {
                tone = 'warn';
            } else if (KPI_PASS_TONE_RE.test(localContext)) {
                tone = 'pass';
            }

            let cleanLabel = tail
                .replace(/^(?:因[^，。]{2,12})/, '')
                .replace(/^(?:当前版本已两轮调试|当前版本)/, '')
                .replace(/(?:并上传|并回读|并检查.*)$/, '')
                .trim();
            if (!cleanLabel) {
                cleanLabel = prefix.replace(/^[共已]+\s*/, '').trim();
            }
            if (cleanLabel === '场景' && prefix.includes('共')) {
                cleanLabel = '实测场景';
            }
            if (cleanLabel.length > 10) {
                if (cleanLabel.includes('独立商品')) cleanLabel = '独立商品';
                else if (cleanLabel.includes('场景通过') || cleanLabel === '通过') cleanLabel = '场景通过';
                else if (cleanLabel.includes('未通过')) cleanLabel = '未通过';
                else if (cleanLabel.includes('跳过')) cleanLabel = '范围跳过';
                else if (cleanLabel.includes('已上线')) cleanLabel = '已上线';
                else if (cleanLabel.includes('精确回绑')) cleanLabel = '精确回绑';
                else if (cleanLabel.includes('已上传')) cleanLabel = '已上传';
                else cleanLabel = cleanLabel.slice(0, 10);
            }
            if (!cleanLabel || seenLabels.has(`${numStr}${unit}:${cleanLabel}`)) { continue; }
            seenLabels.add(`${numStr}${unit}:${cleanLabel}`);

            items.push({
                value: `${numStr} ${unit}`,
                label: cleanLabel,
                tone,
            });
            if (items.length >= 4) {
                return items;
            }
        }
    }

    return items.length >= 2 ? items : [];
}

function applyExecSummary(root: HTMLElement): void {
    const h1 = root.querySelector('h1');
    if (!h1 || h1.parentElement !== root) { return; }

    const leadParas: HTMLParagraphElement[] = [];
    let cur = h1.nextElementSibling;
    while (cur && cur.tagName === 'P' && leadParas.length < 4) {
        leadParas.push(cur as HTMLParagraphElement);
        cur = cur.nextElementSibling;
    }
    if (leadParas.length === 0) { return; }

    const combined = leadParas.map(p => (p.textContent ?? '').trim()).join('\n');
    if (!REPORT_CONTEXT_RE.test(combined)) { return; }

    const wrapper = document.createElement('div');
    wrapper.className = 'folio-exec-summary-card';
    h1.insertAdjacentElement('afterend', wrapper);

    const kpis = extractReportKpis(leadParas);
    if (kpis.length >= 2) {
        const strip = document.createElement('div');
        strip.className = 'folio-kpi-strip folio-restructure-only';
        kpis.forEach(item => {
            const card = document.createElement('div');
            card.className = `folio-kpi-item is-${item.tone}`;
            const valEl = document.createElement('span');
            valEl.className = 'folio-kpi-val';
            valEl.textContent = item.value;
            const lblEl = document.createElement('span');
            lblEl.className = 'folio-kpi-label';
            lblEl.textContent = item.label;
            card.append(lblEl, valEl);
            strip.appendChild(card);
        });
        wrapper.appendChild(strip);
    }

    leadParas.forEach(p => wrapper.appendChild(p));
}

function wrapPrefixKeyInTextNode(textNode: Text, match: RegExpMatchArray): void {
    const raw = textNode.nodeValue ?? '';
    const key = match[1];
    const colon = match[2];
    if (!key || CLOCK_OR_URL_RE.test(`${key}${colon}`) || /^(?:http|https)$/i.test(key)) { return; }

    const fullPrefixLen = key.length + colon.length;
    const frag = document.createDocumentFragment();
    const span = document.createElement('span');
    span.className = 'folio-kv-key';
    span.textContent = raw.slice(0, fullPrefixLen);
    frag.appendChild(span);

    const rest = raw.slice(fullPrefixLen);
    if (rest) {
        frag.appendChild(document.createTextNode(rest));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
}

function applyParagraphAndListStructure(root: HTMLElement): void {
    // Lead subheadings: short paragraph ending with colon immediately preceding list/table
    root.querySelectorAll<HTMLParagraphElement>('p').forEach(p => {
        if (p.closest('.folio-gfm-alert, .folio-exec-summary-card')) { return; }
        const next = p.nextElementSibling;
        const text = (p.textContent ?? '').trim();
        if (
            next
            && (next.tagName === 'UL' || next.tagName === 'OL' || next.classList.contains('table-wrapper'))
            && !text.includes('\n')
            && text.length >= 2
            && text.length <= 28
            && (text.endsWith('：') || text.endsWith(':'))
            && !CLOCK_OR_URL_RE.test(text)
        ) {
            p.classList.add('folio-lead-subheading');
        }
    });

    // Multi-line Key: Value paragraph splitting + lead key highlight
    root.querySelectorAll<HTMLParagraphElement>('p').forEach(p => {
        if (p.classList.contains('folio-lead-subheading') || p.closest('.folio-gfm-alert')) { return; }

        const directTextNodes = Array.from(p.childNodes).filter(
            (n): n is Text => n.nodeType === Node.TEXT_NODE
        );
        for (const textNode of directTextNodes) {
            const val = textNode.nodeValue ?? '';
            if (!val.includes('\n')) { continue; }

            KV_AFTER_NEWLINE_RE.lastIndex = 0;
            const matches = Array.from(val.matchAll(KV_AFTER_NEWLINE_RE));
            if (matches.length === 0) { continue; }

            const frag = document.createDocumentFragment();
            let cursor = 0;
            for (const m of matches) {
                const key = m[1];
                const colon = m[2];
                const nlIndex = m.index ?? 0;
                if (CLOCK_OR_URL_RE.test(`${key}${colon}`) || /^(?:http|https)$/i.test(key)) {
                    continue;
                }
                if (nlIndex + 1 > cursor) {
                    frag.appendChild(document.createTextNode(val.slice(cursor, nlIndex + 1)));
                }
                const br = document.createElement('br');
                br.className = 'folio-auto-br folio-restructure-only';
                frag.appendChild(br);

                const span = document.createElement('span');
                span.className = 'folio-kv-key';
                span.textContent = `${key}${colon}`;
                frag.appendChild(span);

                cursor = nlIndex + 1 + key.length + colon.length;
            }
            if (cursor > 0) {
                if (cursor < val.length) {
                    frag.appendChild(document.createTextNode(val.slice(cursor)));
                }
                p.replaceChild(frag, textNode);
            }
        }

        const firstNode = p.firstChild;
        if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
            const m = (firstNode.nodeValue ?? '').match(KV_LINE_START_RE);
            if (m) {
                wrapPrefixKeyInTextNode(firstNode as Text, m);
            }
        }
    });

    // List item leading Key: highlight
    root.querySelectorAll<HTMLLIElement>('li').forEach(li => {
        const firstText = getFirstSignificantTextNode(li);
        if (!firstText) { return; }
        // Only highlight when text is actually at the beginning of this li (or its inner first <p>)
        const firstContainer = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
        if (firstContainer.firstChild !== firstText) { return; }

        const m = (firstText.nodeValue ?? '').match(LI_LEAD_KEY_RE);
        if (m) {
            wrapPrefixKeyInTextNode(firstText, m);
        }
    });
}

function applyDefectCallouts(root: HTMLElement): void {
    root.querySelectorAll<HTMLParagraphElement>('p').forEach(p => {
        if (p.closest('.folio-exec-summary-card, .folio-gfm-alert, .folio-auto-callout')) { return; }
        if (p.classList.contains('folio-lead-subheading')) { return; }

        const prev = p.previousElementSibling;
        const firstEl = p.firstElementChild;
        const startsWithStrong = firstEl?.tagName === 'STRONG' && p.firstChild === firstEl;
        const strongText = startsWithStrong ? (firstEl.textContent ?? '') : '';

        if (startsWithStrong && DEFECT_STRONG_RE.test(strongText)) {
            p.classList.add('folio-auto-callout', 'is-warning');
            return;
        }
        if (prev && /^H[23]$/.test(prev.tagName) && DEFECT_HEADING_RE.test(prev.textContent ?? '')) {
            const txt = (p.textContent ?? '').trim();
            if (txt.length >= 12) {
                p.classList.add('folio-auto-callout', 'is-warning');
            }
        }
    });
}

function applyMappedPostTableColumn(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.table-wrapper').forEach(wrapper => {
        const table = wrapper.querySelector('table');
        const nextEl = wrapper.nextElementSibling;
        if (!table || !nextEl || nextEl.tagName !== 'P') { return; }

        const theadRow = table.querySelector('thead tr');
        const bodyRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'));
        if (!theadRow || bodyRows.length < 3) { return; }

        const rowKeyMap = new Map<string, HTMLTableRowElement>();
        for (const row of bodyRows) {
            const key = (row.cells[0]?.textContent ?? '').trim();
            if (!key || rowKeyMap.has(key)) {
                return;
            }
            rowKeyMap.set(key, row);
        }

        const firstSentence = (nextEl.textContent ?? '').split('。')[0] ?? '';
        const kvPairs: Array<[string, string]> = [];
        const seenKeys = new Set<string>();
        ROW_KV_PAIR_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ROW_KV_PAIR_RE.exec(firstSentence)) !== null) {
            const k = match[1];
            const v = match[2];
            if (!rowKeyMap.has(k) || seenKeys.has(k)) {
                return;
            }
            seenKeys.add(k);
            kvPairs.push([k, v]);
        }
        if (kvPairs.length < 3) { return; }

        const valueByKey = new Map(kvPairs);
        const th = document.createElement('th');
        th.className = 'folio-restructure-only';
        th.textContent = '关联记录';
        theadRow.appendChild(th);

        for (const [key, row] of rowKeyMap.entries()) {
            const td = document.createElement('td');
            td.className = 'folio-restructure-only';
            const val = valueByKey.get(key);
            if (val) {
                const code = document.createElement('code');
                code.className = 'hljs code-inline folio-auto-code';
                code.textContent = val;
                td.appendChild(code);
            } else {
                const span = document.createElement('span');
                span.className = 'folio-cell-muted';
                span.textContent = '—';
                td.appendChild(span);
            }
            row.appendChild(td);
        }

        nextEl.classList.add('folio-mapped-source-para');
    });
}

function setSectionCollapsed(
    heading: HTMLElement,
    body: HTMLElement,
    pill: HTMLButtonElement,
    collapsed: boolean
): void {
    heading.classList.toggle('is-section-collapsed', collapsed);
    body.classList.toggle('is-collapsed', collapsed);
    const foldBtn = heading.querySelector<HTMLButtonElement>('.folio-section-fold-btn');
    if (foldBtn) {
        foldBtn.setAttribute('aria-expanded', String(!collapsed));
        foldBtn.textContent = collapsed ? '▸' : '▾';
    }
    pill.style.display = collapsed ? '' : 'none';
}

function applyCollapsibleSections(root: HTMLElement, onLayoutChanged?: () => void): void {
    const h2List = Array.from(root.children).filter(
        (el): el is HTMLHeadingElement => el.tagName === 'H2'
    );
    if (h2List.length === 0) { return; }

    const allowAutoFold = h2List.length >= 4;

    h2List.forEach(h2 => {
        const body = document.createElement('div');
        body.className = 'folio-section-body';

        const siblingsToWrap: Node[] = [];
        let cursor = h2.nextSibling;
        while (cursor) {
            if (cursor.nodeType === Node.ELEMENT_NODE) {
                const tag = (cursor as Element).tagName;
                if (tag === 'H1' || tag === 'H2') { break; }
            }
            siblingsToWrap.push(cursor);
            cursor = cursor.nextSibling;
        }
        if (siblingsToWrap.length === 0) { return; }

        h2.insertAdjacentElement('afterend', body);
        siblingsToWrap.forEach(node => body.appendChild(node));

        const foldBtn = document.createElement('button');
        foldBtn.type = 'button';
        foldBtn.className = 'folio-section-fold-btn folio-restructure-only';
        foldBtn.textContent = '▾';
        foldBtn.title = '折叠 / 展开此章节';
        foldBtn.setAttribute('aria-expanded', 'true');
        h2.insertBefore(foldBtn, h2.firstChild);

        const itemCount = body.querySelectorAll('li, p, tr').length || body.children.length;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'folio-section-fold-pill folio-restructure-only';
        pill.textContent = `已收起 ${itemCount} 条明细 · 点击展开查看`;
        pill.style.display = 'none';
        h2.insertAdjacentElement('afterend', pill);

        const toggle = () => {
            const nextCollapsed = !body.classList.contains('is-collapsed');
            setSectionCollapsed(h2, body, pill, nextCollapsed);
            onLayoutChanged?.();
        };

        foldBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggle();
        });
        pill.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSectionCollapsed(h2, body, pill, false);
            onLayoutChanged?.();
        });

        const headingTitle = (h2.textContent ?? '').replace(/^[▾▸]\s*/, '').trim();
        if (allowAutoFold && AUTO_FOLD_HEADING_RE.test(headingTitle)) {
            setSectionCollapsed(h2, body, pill, true);
        }
    });
}

export function expandCollapsedAncestors(target: Element | null, onLayoutChanged?: () => void): boolean {
    if (!target) { return false; }
    let changed = false;
    let cur: Element | null = target;
    while (cur) {
        if (cur.classList.contains('folio-section-body') && cur.classList.contains('is-collapsed')) {
            const prev = cur.previousElementSibling;
            const heading = prev?.classList.contains('folio-section-fold-pill')
                ? prev.previousElementSibling
                : prev;
            const pill = prev?.classList.contains('folio-section-fold-pill')
                ? (prev as HTMLButtonElement)
                : null;
            if (heading instanceof HTMLElement && pill) {
                setSectionCollapsed(heading, cur as HTMLElement, pill, false);
                changed = true;
            } else {
                cur.classList.remove('is-collapsed');
                changed = true;
            }
        }
        cur = cur.parentElement;
    }
    if (changed) {
        onLayoutChanged?.();
    }
    return changed;
}

export function applySmartDocRestructure(root: HTMLElement, onLayoutChanged?: () => void): void {
    applyExecSummary(root);
    applyParagraphAndListStructure(root);
    applyDefectCallouts(root);
    applyMappedPostTableColumn(root);
    applyCollapsibleSections(root, onLayoutChanged);
}

// ─── Plugin Smart Enhancements (Zero Data Mutation) ───────────────────────────

function applyGfmAlerts(root: HTMLElement): void {
    root.querySelectorAll<HTMLQuoteElement>('blockquote').forEach(bq => {
        const firstP = bq.querySelector('p');
        if (!firstP || firstP.parentElement !== bq) { return; }
        const firstText = getFirstSignificantTextNode(firstP);
        if (!firstText || firstP.firstChild !== firstText) { return; }

        const val = firstText.nodeValue ?? '';
        const match = val.match(GFM_ALERT_RE);
        if (!match) { return; }

        const rawType = match[1].toLowerCase();
        const inlineTitle = (match[2] ?? '').trim();
        const fullPrefixLen = match[0].length;

        bq.classList.add('folio-gfm-alert', `is-${rawType}`);

        const head = document.createElement('div');
        head.className = 'folio-gfm-alert-head folio-restructure-only';
        head.textContent = inlineTitle || GFM_ALERT_TITLES[rawType] || rawType.toUpperCase();
        bq.insertBefore(head, bq.firstChild);

        // Keep exact original marker in hidden syntax span for lossless Plain Text copy
        const syntaxSpan = document.createElement('span');
        syntaxSpan.className = 'folio-alert-syntax';
        syntaxSpan.textContent = val.slice(0, fullPrefixLen);

        const frag = document.createDocumentFragment();
        frag.appendChild(syntaxSpan);
        const rest = val.slice(fullPrefixLen);
        if (rest) {
            frag.appendChild(document.createTextNode(rest));
        }
        firstP.replaceChild(frag, firstText);
    });
}

function applyTableStatusPills(root: HTMLElement): void {
    root.querySelectorAll<HTMLTableCellElement>('td:not(.folio-restructure-only)').forEach(td => {
        if (td.children.length > 0) { return; }
        const raw = (td.textContent ?? '').trim();
        if (!raw || raw.length > 22) { return; }

        let pillCls = '';
        if (STATUS_PASS_RE.test(raw)) {
            pillCls = 'is-pass';
        } else if (STATUS_FAIL_RE.test(raw)) {
            pillCls = 'is-fail';
        } else if (STATUS_SKIP_RE.test(raw)) {
            pillCls = 'is-skip';
        }
        if (!pillCls) { return; }

        const pill = document.createElement('span');
        pill.className = `folio-status-pill ${pillCls}`;
        pill.textContent = raw;
        td.textContent = '';
        td.appendChild(pill);

        const tr = td.parentElement;
        if (tr instanceof HTMLTableRowElement) {
            if (pillCls === 'is-fail') {
                tr.classList.add('folio-row-fail');
            } else if (pillCls === 'is-skip' && !tr.classList.contains('folio-row-fail')) {
                tr.classList.add('folio-row-skip');
            }
        }
    });
}

function collectTextSpans(text: string): TextMatchSpan[] {
    const candidates: TextMatchSpan[] = [];

    INLINE_RGB_GLOBAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_RGB_GLOBAL_RE.exec(text)) !== null) {
        if (isValidRgbChannels(m[1], m[2], m[3])) {
            candidates.push({
                start: m.index,
                end: m.index + m[0].length,
                kind: 'rgb',
                text: m[0],
                cssColor: `rgb(${m[1]}, ${m[2]}, ${m[3]})`,
            });
        }
    }

    BARE_HEX_HASH_RE.lastIndex = 0;
    while ((m = BARE_HEX_HASH_RE.exec(text)) !== null) {
        const hex = m[1];
        if (/\d/.test(hex) && /[a-f]/i.test(hex)) {
            candidates.push({
                start: m.index,
                end: m.index + hex.length,
                kind: 'hash',
                text: hex,
            });
        }
    }

    BARE_TECH_TOKEN_RE.lastIndex = 0;
    while ((m = BARE_TECH_TOKEN_RE.exec(text)) !== null) {
        candidates.push({
            start: m.index,
            end: m.index + m[0].length,
            kind: 'token',
            text: m[0],
        });
    }

    candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const chosen: TextMatchSpan[] = [];
    let lastEnd = 0;
    for (const span of candidates) {
        if (span.start < lastEnd) { continue; }
        chosen.push(span);
        lastEnd = span.end;
    }
    return chosen;
}

function applyColorSwatchesAndBareTokens(root: HTMLElement): void {
    // Add inline swatches inside existing <code>rgb(...)</code> / <code>#hex</code>
    root.querySelectorAll<HTMLElement>('code:not(pre code)').forEach(code => {
        if (code.children.length > 0 || code.closest('.katex')) { return; }
        const raw = (code.textContent ?? '').trim();
        const rgbMatch = raw.match(EXACT_RGB_RE);
        let swatchColor = '';
        if (rgbMatch && isValidRgbChannels(rgbMatch[1], rgbMatch[2], rgbMatch[3])) {
            swatchColor = `rgb(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]})`;
        } else if (EXACT_HEX_COLOR_RE.test(raw)) {
            swatchColor = raw;
        }
        if (!swatchColor) { return; }

        const swatch = document.createElement('span');
        swatch.className = 'folio-color-swatch';
        swatch.style.background = swatchColor;
        code.insertBefore(swatch, code.firstChild);
    });

    // Walk text nodes outside headings, pre/code, links, math, and existing enhancements
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) { return NodeFilter.FILTER_REJECT; }
            if (parent.closest('pre, code, a, button, .katex, .folio-heading-tools, .folio-table-tools, .folio-link-gallery, .folio-restructure-only, .folio-status-pill, .folio-kv-key, .folio-bare-file, .folio-alert-syntax, h1, h2, h3, h4, h5, h6, script, style')) {
                return NodeFilter.FILTER_REJECT;
            }
            const val = node.nodeValue ?? '';
            return val.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
    });

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode as Text);
    }

    for (const textNode of textNodes) {
        const val = textNode.nodeValue ?? '';
        const spans = collectTextSpans(val);
        if (spans.length === 0) { continue; }

        const frag = document.createDocumentFragment();
        let cursor = 0;

        for (const span of spans) {
            if (span.start > cursor) {
                frag.appendChild(document.createTextNode(val.slice(cursor, span.start)));
            }

            if (span.kind === 'rgb') {
                const wrap = document.createElement('span');
                wrap.className = 'folio-rgb-inline';
                const swatch = document.createElement('span');
                swatch.className = 'folio-color-swatch';
                swatch.style.background = span.cssColor ?? span.text;
                wrap.append(swatch, document.createTextNode(span.text));
                frag.appendChild(wrap);
            } else if (span.kind === 'hash') {
                const chip = document.createElement('span');
                chip.className = 'folio-hash-chip folio-copyable-code';
                chip.dataset.rawCode = span.text;
                chip.dataset.tokenCategory = 'Hash/Trace';
                chip.dataset.inlineEnhanced = 'true';
                chip.title = `单击复制完整串：${span.text}`;

                const fullSpan = document.createElement('span');
                fullSpan.className = 'folio-hash-full';
                fullSpan.textContent = span.text;

                const shortSpan = document.createElement('span');
                shortSpan.className = 'folio-hash-short';
                shortSpan.setAttribute('aria-hidden', 'true');
                shortSpan.textContent = `${span.text.slice(0, 8)}…${span.text.slice(-6)}`;

                chip.append(fullSpan, shortSpan);
                frag.appendChild(chip);
            } else {
                const code = document.createElement('code');
                code.className = 'hljs code-inline folio-auto-code';
                code.textContent = span.text;
                frag.appendChild(code);
            }

            cursor = span.end;
        }

        if (cursor < val.length) {
            frag.appendChild(document.createTextNode(val.slice(cursor)));
        }
        textNode.parentNode?.replaceChild(frag, textNode);
    }
}

export function applySmartEnhancements(root: HTMLElement): void {
    applyGfmAlerts(root);
    applyTableStatusPills(root);
    applyColorSwatchesAndBareTokens(root);
}
