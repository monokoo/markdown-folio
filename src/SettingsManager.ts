import * as vscode from 'vscode';

export interface PreviewSettings {
    headingFont: string;
    bodyFont: string;
    fontSize: number;
    headingSize: 'S' | 'M' | 'L';
    lineSpacing: 'compact' | 'normal' | 'relaxed';
    pageWidth: 'narrow' | 'standard' | 'wide' | 'fluid' | 'full';
    showToolbar: boolean;
    showTocSidebar: boolean;
    theme: 'admiral' | 'ivory' | 'serene' | 'cyberpunk' | 'dracula' | 'github' | 'zen';
    scrollSync: boolean;
    tableWrapThreshold: number;
    clickInlineCodeCopy: boolean;
    expandImageLinks: boolean;
}

const DEFAULTS: PreviewSettings = {
    headingFont: "'Merriweather', Georgia, serif",
    bodyFont: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
    fontSize: 16,
    headingSize: 'M',
    lineSpacing: 'normal',
    pageWidth: 'standard',
    showToolbar: true,
    showTocSidebar: true,
    theme: 'ivory',
    scrollSync: true,
    tableWrapThreshold: 320,
    clickInlineCodeCopy: true,
    expandImageLinks: false,
};

export class SettingsManager {
    private static readonly _section = 'markdownFolio';

    static read(): PreviewSettings {
        const cfg = vscode.workspace.getConfiguration(SettingsManager._section);
        return {
            headingFont: cfg.get<string>('headingFont', DEFAULTS.headingFont),
            bodyFont: cfg.get<string>('bodyFont', DEFAULTS.bodyFont),
            fontSize: cfg.get<number>('fontSize', DEFAULTS.fontSize),
            headingSize: cfg.get<'S' | 'M' | 'L'>('headingSize', DEFAULTS.headingSize),
            lineSpacing: cfg.get<'compact' | 'normal' | 'relaxed'>('lineSpacing', DEFAULTS.lineSpacing),
            pageWidth: cfg.get<'narrow' | 'standard' | 'wide' | 'fluid' | 'full'>('pageWidth', DEFAULTS.pageWidth),
            showToolbar: cfg.get<boolean>('showToolbar', DEFAULTS.showToolbar),
            showTocSidebar: cfg.get<boolean>('showTocSidebar', DEFAULTS.showTocSidebar),
            theme: cfg.get<'admiral' | 'ivory' | 'serene' | 'cyberpunk' | 'dracula' | 'github' | 'zen'>('theme', DEFAULTS.theme),
            scrollSync: cfg.get<boolean>('scrollSync', DEFAULTS.scrollSync),
            tableWrapThreshold: SettingsManager._clampThreshold(cfg.get<number>('tableWrapThreshold', DEFAULTS.tableWrapThreshold)),
            clickInlineCodeCopy: cfg.get<boolean>('clickInlineCodeCopy', DEFAULTS.clickInlineCodeCopy),
            expandImageLinks: cfg.get<boolean>('expandImageLinks', DEFAULTS.expandImageLinks),
        };
    }

    private static _clampThreshold(value: number): number {
        if (!Number.isFinite(value) || value <= 0) {
            return 0;
        }
        return Math.max(120, Math.min(800, Math.round(value)));
    }

    static async update(partial: Partial<PreviewSettings>): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(SettingsManager._section);
        const promises = Object.entries(partial).map(([key, value]) =>
            cfg.update(key, value, vscode.ConfigurationTarget.Global)
        );
        await Promise.all(promises);
    }

    static onDidChange(callback: (settings: PreviewSettings) => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(SettingsManager._section)) {
                callback(SettingsManager.read());
            }
        });
    }
}
