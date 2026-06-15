/**
 * Rootweave — Obsidian plugin for conlang worldbuilders
 *
 * DATA STORAGE PHILOSOPHY
 * =======================
 * All data lives as plain Markdown tables inside your vault:
 *
 *   .rootweave/Roots.md      ← root morpheme lexicon
 *   .rootweave/Dictionary.md ← finalized word list
 *   .rootweave/Grammar.md    ← grammar rules
 *
 * You can open, read, and edit these files like any other Obsidian note —
 * even if the plugin is disabled or uninstalled. The plugin is just a
 * convenient UI for working with those tables.
 *
 * HOW OBSIDIAN PLUGINS WORK (quick orientation for new plugin devs)
 * ================================================================
 * - `Plugin`     the entry point. onload() runs when enabled.
 * - `ItemView`   a sidebar panel. Build its UI in onOpen() with DOM methods.
 * - `Modal`      a popup dialog.
 * - `Notice`     a toast notification.
 * - `vault`      the only safe way to read/write files (works on mobile too).
 */

import {
    App,
    ItemView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath,
} from 'obsidian';

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE    = 'rootweave-view';
const ROOTS_FILE   = '.rootweave/Roots.md';
const DICT_FILE    = '.rootweave/Dictionary.md';
const GRAMMAR_FILE = '.rootweave/Grammar.md';

// ─── Interfaces ───────────────────────────────────────────────────────────────
// No ID fields — the root string and word string are natural unique keys.

interface Root {
    root: string;
    meaning: string;
    category: string;
    notes: string;
}

interface DictionaryEntry {
    word: string;
    meaning: string;
    partOfSpeech: string;
    roots: string[]; // root strings that compose this word, e.g. ["vel", "kar"]
}

interface GrammarRule {
    description: string;
    pattern: string;       // JavaScript regex
    ruleType: 'required' | 'forbidden';
    message: string;
}

interface RootweaveSettings {
    language: string;
}

const DEFAULT_SETTINGS: RootweaveSettings = { language: 'My Conlang' };

const DEFAULT_GRAMMAR: GrammarRule[] = [
    {
        description: 'Words must end in a vowel',
        pattern: '[aeiou]$',
        ruleType: 'required',
        message: 'This word does not end in a vowel.',
    },
    {
        description: 'No triple consonants in a row',
        pattern: '[^aeiou]{3}',
        ruleType: 'forbidden',
        message: 'Three consecutive consonants are not allowed.',
    },
];

// ─── Markdown table utilities ─────────────────────────────────────────────────
//
// The data files are regular Markdown notes with tables:
//
//   | root | meaning   | category | notes |
//   | ---- | --------- | -------- | ----- |
//   | vel  | light     | element  |       |
//   | kar  | fire      | element  |       |
//
// These render as nice tables inside Obsidian even without the plugin.

function escapeCell(s: string): string {
    // Pipe characters inside a Markdown table cell must be escaped as \|
    return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function unescapeCell(s: string): string {
    return (s ?? '').replace(/\\\|/g, '|');
}

/**
 * Parse the first Markdown table found in `content` into an array of objects.
 * Ignores any text before or after the table (headings, descriptions, etc.).
 */
function parseMarkdownTable(content: string): Record<string, string>[] {
    const lines = content.split('\n');

    // Collect the first contiguous block of | lines
    const tableLines: string[] = [];
    let inTable = false;
    for (const line of lines) {
        if (line.trim().startsWith('|')) {
            inTable = true;
            tableLines.push(line.trim());
        } else if (inTable) {
            break; // first non-pipe line after the table ends it
        }
    }

    // Need at least: header row, separator row, one data row
    if (tableLines.length < 3) return [];

    const headers = tableLines[0]
        .split('|')
        .slice(1, -1)
        .map(h => h.trim().toLowerCase());

    // tableLines[1] is the separator (| --- | --- |) — skip it
    return tableLines.slice(2).map(row => {
        const cells = row.split('|').slice(1, -1).map(c => unescapeCell(c.trim()));
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
        return obj;
    });
}

/**
 * Render `rows` as a Markdown table string with auto-padded column widths.
 */
function buildMarkdownTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => (r[i] ?? '').length), 3)
    );
    const pad  = (s: string, w: number) => s.padEnd(w);
    const dash = (w: number) => '-'.repeat(w);

    const header  = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |';
    const sepLine = '| ' + widths.map(dash).join(' | ') + ' |';
    const body    = rows.map(row =>
        '| ' + headers.map((_, i) => pad(escapeCell(row[i] ?? ''), widths[i])).join(' | ') + ' |'
    );

    return [header, sepLine, ...body].join('\n');
}

// ─── Per-type serializers / deserializers ──────────────────────────────────────

const ROOT_HEADERS = ['root', 'meaning', 'category', 'notes'];
const DICT_HEADERS = ['word', 'meaning', 'part of speech', 'roots'];
const GRAMMAR_HEADERS = ['description', 'pattern', 'type', 'message'];

function parseRoots(content: string): Root[] {
    return parseMarkdownTable(content)
        .map(row => ({
            root:     row['root']     ?? '',
            meaning:  row['meaning']  ?? '',
            category: row['category'] ?? '',
            notes:    row['notes']    ?? '',
        }))
        .filter(r => r.root.trim() !== '');
}

function serializeRoots(roots: Root[]): string {
    const rows = roots.map(r => [r.root, r.meaning, r.category, r.notes]);
    return [
        '# Root Lexicon',
        '',
        'Add roots here directly, or use the **Rootweave panel** (the 📖 ribbon icon).',
        '',
        buildMarkdownTable(ROOT_HEADERS, rows),
    ].join('\n');
}

function parseDictionary(content: string): DictionaryEntry[] {
    return parseMarkdownTable(content)
        .map(row => ({
            word:        row['word']           ?? '',
            meaning:     row['meaning']        ?? '',
            partOfSpeech: row['part of speech'] ?? '',
            // roots are stored as "+ "-separated strings, e.g. "vel + kar"
            roots: (row['roots'] ?? '').split('+').map(r => r.trim()).filter(Boolean),
        }))
        .filter(e => e.word.trim() !== '');
}

function serializeDictionary(dict: DictionaryEntry[]): string {
    const rows = dict.map(e => [
        e.word,
        e.meaning,
        e.partOfSpeech,
        e.roots.join(' + '),
    ]);
    return [
        '# Dictionary',
        '',
        'Add words here directly, or use the **Builder tab** in the Rootweave panel.',
        '',
        buildMarkdownTable(DICT_HEADERS, rows),
    ].join('\n');
}

function parseGrammar(content: string): GrammarRule[] {
    return parseMarkdownTable(content)
        .map(row => ({
            description: row['description'] ?? '',
            pattern:     row['pattern']     ?? '',
            ruleType:    (row['type'] === 'forbidden' ? 'forbidden' : 'required') as 'required' | 'forbidden',
            message:     row['message']     ?? '',
        }))
        .filter(r => r.pattern.trim() !== '');
}

function serializeGrammar(rules: GrammarRule[]): string {
    const rows = rules.map(r => [r.description, r.pattern, r.ruleType, r.message]);
    return [
        '# Grammar Rules',
        '',
        'Patterns are JavaScript regular expressions tested against each word in the Builder.',
        '',
        '- **required** — the pattern must match the word (flagged if it doesn\'t)',
        '- **forbidden** — the pattern must not appear in the word (flagged if it does)',
        '',
        buildMarkdownTable(GRAMMAR_HEADERS, rows),
    ].join('\n');
}

// ─── Main Plugin Class ────────────────────────────────────────────────────────

export default class RootweavePlugin extends Plugin {
    settings: RootweaveSettings;

    async onload() {
        await this.loadSettings();

        // Register the sidebar view type.
        // Obsidian calls the factory function whenever it needs to create the view.
        this.registerView(VIEW_TYPE, (leaf) => new RootweaveView(leaf, this));

        this.addRibbonIcon('book-open', 'Rootweave', () => this.activateView());

        this.addCommand({
            id: 'open-rootweave',
            name: 'Open Rootweave Panel',
            callback: () => this.activateView(),
        });

        this.addSettingTab(new RootweaveSettingTab(this.app, this));
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: VIEW_TYPE, active: true });
                leaf = rightLeaf;
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
    }

    // ── Vault I/O ──────────────────────────────────────────────────────────────

    /** Read a file's raw text, or null if it doesn't exist yet */
    async readMd(path: string): Promise<string | null> {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) return null;
        return this.app.vault.read(file);
    }

    /** Write text to a file, creating the file and its parent folder if needed */
    async writeMd(path: string, content: string): Promise<void> {
        const normalPath = normalizePath(path);
        const dir = normalPath.split('/').slice(0, -1).join('/');

        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }

        const existing = this.app.vault.getAbstractFileByPath(normalPath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
        } else {
            await this.app.vault.create(normalPath, content);
        }
    }

    // ── Data accessors ─────────────────────────────────────────────────────────

    async loadRoots(): Promise<Root[]> {
        const content = await this.readMd(ROOTS_FILE);
        return content ? parseRoots(content) : [];
    }

    async saveRoots(roots: Root[]): Promise<void> {
        await this.writeMd(ROOTS_FILE, serializeRoots(roots));
    }

    async loadDictionary(): Promise<DictionaryEntry[]> {
        const content = await this.readMd(DICT_FILE);
        return content ? parseDictionary(content) : [];
    }

    async saveDictionary(dict: DictionaryEntry[]): Promise<void> {
        await this.writeMd(DICT_FILE, serializeDictionary(dict));
    }

    async loadGrammar(): Promise<GrammarRule[]> {
        const content = await this.readMd(GRAMMAR_FILE);
        return content ? parseGrammar(content) : DEFAULT_GRAMMAR;
    }

    async saveGrammar(rules: GrammarRule[]): Promise<void> {
        await this.writeMd(GRAMMAR_FILE, serializeGrammar(rules));
    }

    // ── Plugin settings ────────────────────────────────────────────────────────

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class RootweaveView extends ItemView {
    plugin: RootweavePlugin;
    private activeTab: 'roots' | 'builder' | 'dictionary' | 'translator' | 'export' = 'roots';

    private roots: Root[] = [];
    private dictionary: DictionaryEntry[] = [];
    private grammar: GrammarRule[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: RootweavePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string    { return VIEW_TYPE; }
    getDisplayText(): string { return 'Rootweave'; }
    getIcon(): string        { return 'book-open'; }

    async onOpen() {
        [this.roots, this.dictionary, this.grammar] = await Promise.all([
            this.plugin.loadRoots(),
            this.plugin.loadDictionary(),
            this.plugin.loadGrammar(),
        ]);

        // Write Grammar.md on first launch so it exists and is self-documenting
        const grammarFile = this.app.vault.getAbstractFileByPath(normalizePath(GRAMMAR_FILE));
        if (!grammarFile) await this.plugin.saveGrammar(this.grammar);

        this.render();
    }

    async onClose() { /* nothing to tear down */ }

    /** Full re-render. Simple and correct for a panel this size. */
    private render() {
        // this.contentEl is the official Obsidian API property for the view's content area.
        const container = this.contentEl;
        container.empty();
        container.addClass('rootweave-container');

        container.createEl('div', { cls: 'rw-header' })
            .createEl('span', { cls: 'rw-title', text: 'Rootweave' });

        const tabBar = container.createEl('div', { cls: 'rw-tab-bar' });
        const content = container.createEl('div', { cls: 'rw-content' });

        const TABS = [
            { id: 'roots',      label: 'Roots'     },
            { id: 'builder',    label: 'Builder'   },
            { id: 'dictionary', label: 'Dict'      },
            { id: 'translator', label: 'Translate' },
            { id: 'export',     label: 'Export'    },
        ] as const;

        TABS.forEach(tab => {
            const btn = tabBar.createEl('button', {
                cls: `rw-tab-btn${this.activeTab === tab.id ? ' is-active' : ''}`,
                text: tab.label,
            });
            btn.addEventListener('click', () => { this.activeTab = tab.id; this.render(); });
        });

        switch (this.activeTab) {
            case 'roots':      this.renderRootsTab(content);      break;
            case 'builder':    this.renderBuilderTab(content);    break;
            case 'dictionary': this.renderDictionaryTab(content); break;
            case 'translator': this.renderTranslatorTab(content); break;
            case 'export':     this.renderExportTab(content);     break;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TAB: ROOTS
    // ──────────────────────────────────────────────────────────────────────────

    private renderRootsTab(el: HTMLElement) {
        const controls = el.createEl('div', { cls: 'rw-controls' });

        const searchInput = controls.createEl('input', {
            cls: 'rw-input', type: 'text', placeholder: 'Search roots…',
        } as any);

        const categories = ['All', ...new Set(this.roots.map(r => r.category).filter(Boolean))];
        const catSelect  = controls.createEl('select', { cls: 'rw-select' });
        categories.forEach(cat => catSelect.createEl('option', { value: cat, text: cat }));

        const addBtn = controls.createEl('button', { cls: 'rw-btn rw-btn-primary', text: '+ Add Root' });
        addBtn.addEventListener('click', () => {
            new RootModal(this.app, null, async (newRoot) => {
                if (this.roots.some(r => r.root === newRoot.root)) {
                    new Notice(`Root "${newRoot.root}" already exists.`);
                    return;
                }
                this.roots.push(newRoot);
                await this.plugin.saveRoots(this.roots);
                this.render();
            }).open();
        });

        const listEl = el.createEl('div', { cls: 'rw-list' });

        const renderList = () => {
            listEl.empty();
            const query = searchInput.value.toLowerCase();
            const cat   = catSelect.value;

            const filtered = this.roots.filter(r => {
                const matchSearch = !query
                    || r.root.toLowerCase().includes(query)
                    || r.meaning.toLowerCase().includes(query)
                    || r.notes.toLowerCase().includes(query);
                const matchCat = cat === 'All' || r.category === cat;
                return matchSearch && matchCat;
            });

            if (filtered.length === 0) {
                listEl.createEl('p', { cls: 'rw-empty', text: 'No roots found.' });
                return;
            }

            filtered.forEach(root => {
                const card = listEl.createEl('div', { cls: 'rw-card' });
                const info = card.createEl('div', { cls: 'rw-card-info' });
                info.createEl('span', { cls: 'rw-root-text',    text: root.root });
                info.createEl('span', { cls: 'rw-root-meaning', text: ` — ${root.meaning}` });
                if (root.category) info.createEl('span', { cls: 'rw-badge', text: root.category });
                if (root.notes)    card.createEl('div', { cls: 'rw-root-notes', text: root.notes });

                const actions = card.createEl('div', { cls: 'rw-card-actions' });

                const editBtn = actions.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Edit' });
                editBtn.addEventListener('click', () => {
                    new RootModal(this.app, root, async (updated) => {
                        // Find by the original root string (before the edit)
                        const idx = this.roots.findIndex(r => r.root === root.root);
                        if (idx !== -1) this.roots[idx] = updated;
                        await this.plugin.saveRoots(this.roots);
                        this.render();
                    }).open();
                });

                const delBtn = actions.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: 'Delete' });
                delBtn.addEventListener('click', async () => {
                    this.roots = this.roots.filter(r => r.root !== root.root);
                    await this.plugin.saveRoots(this.roots);
                    this.render();
                });
            });
        };

        searchInput.addEventListener('input', renderList);
        catSelect.addEventListener('change', renderList);
        renderList();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TAB: WORD BUILDER
    // ──────────────────────────────────────────────────────────────────────────

    private renderBuilderTab(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Type a word to see its root components and grammar check.' });

        const wordInput = el.createEl('input', {
            cls: 'rw-input rw-input-lg', type: 'text', placeholder: 'Type a word…',
        } as any);

        const suggestionsEl = el.createEl('div', { cls: 'rw-suggestions' });
        const violationsEl  = el.createEl('div', { cls: 'rw-violations' });
        const addWordArea   = el.createEl('div', { cls: 'rw-add-word-area' });

        const analyze = () => {
            const word = wordInput.value.trim();
            suggestionsEl.empty();
            violationsEl.empty();
            addWordArea.empty();
            if (!word) return;

            // ── Root matching ─────────────────────────────────────────────────
            const matchedRoots = this.roots.filter(
                r => r.root.length > 0 && word.toLowerCase().includes(r.root.toLowerCase())
            );

            if (matchedRoots.length > 0) {
                suggestionsEl.createEl('p', { cls: 'rw-label', text: 'Root components:' });
                matchedRoots.forEach(root => {
                    const row = suggestionsEl.createEl('div', { cls: 'rw-suggestion-row' });
                    row.createEl('span', { cls: 'rw-root-chip', text: root.root });
                    row.createEl('span', { text: ` → ${root.meaning}` });
                    if (root.category) row.createEl('span', { cls: 'rw-badge rw-badge-sm', text: root.category });
                });
                const hint = matchedRoots.map(r => r.meaning).join(' + ');
                suggestionsEl.createEl('p', { cls: 'rw-meaning-hint', text: `Composed meaning: ${hint}` });
            } else {
                suggestionsEl.createEl('p', { cls: 'rw-empty', text: 'No matching roots found.' });
            }

            // ── Grammar rule checker ──────────────────────────────────────────
            const violations = this.grammar.filter(rule => {
                try {
                    const hit = new RegExp(rule.pattern, 'i').test(word);
                    return rule.ruleType === 'required' ? !hit : hit;
                } catch { return false; }
            });

            if (violations.length > 0) {
                violationsEl.createEl('p', { cls: 'rw-label rw-label-warn', text: 'Grammar issues:' });
                violations.forEach(rule => {
                    const row = violationsEl.createEl('div', { cls: 'rw-violation-row' });
                    row.title = rule.description;
                    row.createEl('span', { cls: 'rw-violation-icon', text: '⚠ ' });
                    row.createEl('span', { text: rule.message });
                });
            } else {
                violationsEl.createEl('p', { cls: 'rw-ok', text: '✓ No grammar violations.' });
            }

            // ── Add to dictionary ─────────────────────────────────────────────
            addWordArea.createEl('p', { cls: 'rw-label', text: 'Save to dictionary:' });
            const form = addWordArea.createEl('div', { cls: 'rw-add-word-form' });

            const meaningInput = form.createEl('input', {
                cls: 'rw-input', type: 'text', placeholder: 'English meaning',
            } as any);
            const posInput = form.createEl('input', {
                cls: 'rw-input', type: 'text', placeholder: 'Part of speech (noun, verb…)',
            } as any);

            const saveBtn = form.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Add to Dictionary' });
            saveBtn.addEventListener('click', async () => {
                const meaning = meaningInput.value.trim();
                if (!meaning) { new Notice('Please enter a meaning.'); return; }
                if (this.dictionary.some(e => e.word.toLowerCase() === word.toLowerCase())) {
                    new Notice(`"${word}" is already in the dictionary.`); return;
                }
                const entry: DictionaryEntry = {
                    word,
                    meaning,
                    partOfSpeech: posInput.value.trim(),
                    roots: matchedRoots.map(r => r.root),
                };
                this.dictionary.push(entry);
                await this.plugin.saveDictionary(this.dictionary);
                new Notice(`"${word}" added to dictionary!`);
                wordInput.value = '';
                analyze();
            });
        };

        wordInput.addEventListener('input', analyze);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TAB: DICTIONARY
    // ──────────────────────────────────────────────────────────────────────────

    private renderDictionaryTab(el: HTMLElement) {
        const controls = el.createEl('div', { cls: 'rw-controls' });
        const searchInput = controls.createEl('input', {
            cls: 'rw-input', type: 'text', placeholder: 'Search dictionary…',
        } as any);

        const listEl = el.createEl('div', { cls: 'rw-dict-list' });

        const renderList = () => {
            listEl.empty();
            const query = searchInput.value.toLowerCase();
            const filtered = this.dictionary.filter(e =>
                !query
                || e.word.toLowerCase().includes(query)
                || e.meaning.toLowerCase().includes(query)
                || e.partOfSpeech.toLowerCase().includes(query)
            );

            if (filtered.length === 0) {
                listEl.createEl('p', {
                    cls: 'rw-empty',
                    text: this.dictionary.length === 0
                        ? 'No words yet. Use the Builder tab to add some!'
                        : 'No results.',
                });
                return;
            }

            const table = listEl.createEl('table', { cls: 'rw-table' });
            const hRow  = table.createEl('thead').createEl('tr');
            ['Word', 'Meaning', 'PoS', 'Roots', ''].forEach(col => hRow.createEl('th', { text: col }));

            const tbody = table.createEl('tbody');
            filtered.forEach(entry => {
                const row = tbody.createEl('tr');
                row.createEl('td', { cls: 'rw-word-cell', text: entry.word });
                row.createEl('td', { text: entry.meaning });
                row.createEl('td', { text: entry.partOfSpeech });
                row.createEl('td', { text: entry.roots.join(', ') });

                const delBtn = row.createEl('td')
                    .createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: '×' });
                delBtn.title = 'Remove from dictionary';
                delBtn.addEventListener('click', async () => {
                    this.dictionary = this.dictionary.filter(e2 => e2.word !== entry.word);
                    await this.plugin.saveDictionary(this.dictionary);
                    renderList();
                });
            });
        };

        searchInput.addEventListener('input', renderList);
        renderList();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TAB: TRANSLATOR
    // ──────────────────────────────────────────────────────────────────────────

    private renderTranslatorTab(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Translate English → your conlang using the dictionary.' });

        const inputArea = el.createEl('textarea', {
            cls: 'rw-textarea', placeholder: 'Type an English sentence here…',
        } as any);

        const glossLabel = el.createEl('label', { cls: 'rw-toggle-label' });
        const glossCheck = glossLabel.createEl('input') as HTMLInputElement;
        glossCheck.type  = 'checkbox';
        glossLabel.appendText(' Show interlinear gloss');

        const translateBtn = el.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Translate' });
        const outputEl     = el.createEl('div',    { cls: 'rw-translator-output' });

        translateBtn.addEventListener('click', () => {
            outputEl.empty();
            const sentence = inputArea.value.trim();
            if (!sentence) return;

            const tokens = sentence.split(/\s+/);

            const results = tokens.map(token => {
                const m      = token.match(/^([^a-zA-Z]*)([a-zA-Z]*)([^a-zA-Z]*)$/);
                const prefix = m?.[1] ?? '';
                const word   = m?.[2] ?? token;
                const suffix = m?.[3] ?? '';

                // Look up English word in dictionary meanings (split by comma/semicolon/slash)
                const entry = this.dictionary.find(e =>
                    e.meaning.toLowerCase().split(/[\s,;/]+/).some(
                        part => part.trim() === word.toLowerCase()
                    )
                );
                return { prefix, word, suffix, entry };
            });

            if (glossCheck.checked) {
                // ── Interlinear gloss (original on top, translation below) ────
                const glossEl  = outputEl.createEl('div', { cls: 'rw-gloss' });
                const origRow  = glossEl.createEl('div', { cls: 'rw-gloss-row rw-gloss-original' });
                const transRow = glossEl.createEl('div', { cls: 'rw-gloss-row rw-gloss-translation' });

                results.forEach(({ prefix, word, suffix, entry }) => {
                    const origCell  = origRow.createEl('span',  { cls: 'rw-gloss-cell', text: prefix + word + suffix });
                    const transCell = transRow.createEl('span', { cls: 'rw-gloss-cell' });
                    if (entry) {
                        transCell.setText(entry.word);
                        transCell.addClass('rw-gloss-found');
                        origCell.title = `→ ${entry.word}`;
                    } else {
                        transCell.setText('?');
                        transCell.addClass('rw-gloss-missing');
                        origCell.addClass('rw-unknown-word');
                        origCell.title = 'No dictionary entry found';
                    }
                });
            } else {
                // ── Inline translation ────────────────────────────────────────
                const lineEl = outputEl.createEl('div', { cls: 'rw-translation-line' });
                results.forEach(({ prefix, word, suffix, entry }, i) => {
                    if (i > 0) lineEl.appendText(' ');
                    if (prefix) lineEl.appendText(prefix);
                    if (entry) {
                        const span = lineEl.createEl('span', { cls: 'rw-word-found', text: entry.word });
                        span.title = `${word} → ${entry.meaning}`;
                    } else {
                        const span = lineEl.createEl('span', { cls: 'rw-word-missing', text: word });
                        span.title = 'No dictionary entry found';
                    }
                    if (suffix) lineEl.appendText(suffix);
                });
            }

            // Copy button
            const copyBtn = outputEl.createEl('button', { cls: 'rw-btn rw-btn-sm rw-copy-btn', text: 'Copy' });
            copyBtn.addEventListener('click', () => {
                const text = results
                    .map(({ prefix, word, suffix, entry }) => prefix + (entry ? entry.word : word) + suffix)
                    .join(' ');
                navigator.clipboard.writeText(text);
                new Notice('Translation copied!');
            });
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TAB: EXPORT
    // ──────────────────────────────────────────────────────────────────────────

    private renderExportTab(el: HTMLElement) {
        el.createEl('p', {
            cls: 'rw-subtitle',
            text: 'Your data already lives in .rootweave/ as Markdown notes. Export creates a single consolidated snapshot.',
        });

        const stats = el.createEl('div', { cls: 'rw-export-stats' });
        stats.createEl('p', { text: `${this.roots.length} root${this.roots.length !== 1 ? 's' : ''}` });
        stats.createEl('p', { text: `${this.dictionary.length} word${this.dictionary.length !== 1 ? 's' : ''}` });
        stats.createEl('p', { text: `${this.grammar.length} grammar rule${this.grammar.length !== 1 ? 's' : ''}` });

        el.createEl('p', { cls: 'rw-label', text: 'Source files (open directly):' });
        const fileList = el.createEl('div', { cls: 'rw-file-links' });

        [ROOTS_FILE, DICT_FILE, GRAMMAR_FILE].forEach(filePath => {
            const btn = fileList.createEl('button', {
                cls: 'rw-btn rw-btn-sm rw-file-link',
                text: filePath.split('/').pop() ?? filePath,
            });
            btn.addEventListener('click', async () => {
                const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                } else {
                    new Notice(`${filePath} hasn't been created yet — add some data first.`);
                }
            });
        });

        el.createEl('div', { cls: 'rw-divider' });

        const exportBtn = el.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Export Consolidated Snapshot' });
        exportBtn.addEventListener('click', async () => {
            const langName = this.plugin.settings.language;
            const date     = new Date().toISOString().slice(0, 10);

            const lines: string[] = [
                `# ${langName} — ${date}`,
                '',
                serializeRoots(this.roots),
                '',
                serializeDictionary(this.dictionary),
                '',
                serializeGrammar(this.grammar),
            ];

            const filename    = `${langName.replace(/\s+/g, '-').toLowerCase()}-${date}.md`;
            const normalPath  = normalizePath(filename);
            const existing    = this.app.vault.getAbstractFileByPath(normalPath);

            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, lines.join('\n'));
            } else {
                await this.app.vault.create(normalPath, lines.join('\n'));
            }

            new Notice(`Exported to ${filename}`);
        });
    }
}

// ─── Root Add / Edit Modal ────────────────────────────────────────────────────

class RootModal extends Modal {
    private existing: Root | null;
    private onSave: (root: Root) => void;

    constructor(app: App, existing: Root | null, onSave: (root: Root) => void) {
        super(app);
        this.existing = existing;
        this.onSave   = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.existing ? 'Edit Root' : 'Add Root' });

        const field = (label: string, value: string, placeholder: string): HTMLInputElement => {
            const wrapper = contentEl.createEl('div', { cls: 'rw-modal-field' });
            wrapper.createEl('label', { text: label });
            return wrapper.createEl('input', {
                cls: 'rw-input', type: 'text', value, placeholder,
            } as any) as HTMLInputElement;
        };

        const rootInput     = field('Root',     this.existing?.root     ?? '', 'e.g. "vel"');
        const meaningInput  = field('Meaning',  this.existing?.meaning  ?? '', 'e.g. "light, clarity"');
        const categoryInput = field('Category', this.existing?.category ?? '', 'e.g. "element", "emotion"');
        const notesInput    = field('Notes',    this.existing?.notes    ?? '', 'Optional');

        const saveBtn = contentEl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Save' });
        saveBtn.addEventListener('click', () => {
            const rootVal = rootInput.value.trim();
            if (!rootVal) { new Notice('Root cannot be empty.'); return; }
            this.onSave({
                root:     rootVal,
                meaning:  meaningInput.value.trim(),
                category: categoryInput.value.trim(),
                notes:    notesInput.value.trim(),
            });
            this.close();
        });

        [rootInput, meaningInput, categoryInput, notesInput].forEach(inp =>
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); })
        );
    }

    onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class RootweaveSettingTab extends PluginSettingTab {
    plugin: RootweavePlugin;

    constructor(app: App, plugin: RootweavePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Rootweave' });

        new Setting(containerEl)
            .setName('Language name')
            .setDesc('Used in export file names and headings.')
            .addText(text =>
                text
                    .setPlaceholder('My Conlang')
                    .setValue(this.plugin.settings.language)
                    .onChange(async value => {
                        this.plugin.settings.language = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Grammar rules')
            .setDesc('Stored in .rootweave/Grammar.md — open it to add or edit rules.')
            .addButton(btn =>
                btn.setButtonText('Open Grammar.md').onClick(async () => {
                    const file = this.app.vault.getAbstractFileByPath(normalizePath(GRAMMAR_FILE));
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                    } else {
                        new Notice('Open the Rootweave panel first to create Grammar.md.');
                    }
                })
            );
    }
}
