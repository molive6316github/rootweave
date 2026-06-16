/**
 * Rootweave — Obsidian plugin for conlang worldbuilders
 *
 * Data lives as plain Markdown tables in your vault:
 *   .rootweave/Roots.md      ← root morpheme lexicon
 *   .rootweave/Dictionary.md ← finalized word list
 *   .rootweave/Grammar.md    ← grammar rules
 *
 * You can open and edit these files directly — the plugin is just a
 * convenient UI on top of them.
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

const VIEW_TYPE = 'rootweave-view';

const FILES = {
    roots:   '.rootweave/Roots.md',
    words:   '.rootweave/Dictionary.md',
    grammar: '.rootweave/Grammar.md',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Root {
    root: string;
    meaning: string;
    category: string;
    notes: string;
    alternates: string[]; // other forms, e.g. "sight" for root "see"
}

interface Word {
    word: string;
    meaning: string;
    pos: string;     // part of speech
    roots: string[]; // which roots it came from
}

interface Rule {
    name: string;                          // e.g. "Plural"
    type: 'prefix' | 'suffix' | 'infix' | 'other';
    form: string;                          // the affix, e.g. "-iu" or "on-"
    meaning: string;                       // grammatical meaning, e.g. "plural marker"
    example: string;                       // optional: "vel → veliu (lights)"
    notes: string;                         // optional extra info
}

interface Settings {
    language: string;
}

const DEFAULT_SETTINGS: Settings = { language: 'My Conlang' };

const DEFAULT_RULES: Rule[] = [
    { name: 'Plural',     type: 'suffix', form: '-iu',  meaning: 'plural marker', example: 'vel → veliu (lights)',    notes: '' },
    { name: 'Past tense', type: 'prefix', form: 'on-',  meaning: 'past tense',    example: 'vel → onvel (was light)', notes: '' },
];

// ─── Markdown table helpers ───────────────────────────────────────────────────

function escapeCell(s: string): string {
    return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function unescapeCell(s: string): string {
    return (s ?? '').replace(/\\\|/g, '|');
}

function parseMdTable(content: string): Record<string, string>[] {
    const lines = content.split('\n');
    const rows: string[] = [];
    let started = false;
    for (const line of lines) {
        if (line.trim().startsWith('|')) { started = true; rows.push(line.trim()); }
        else if (started) break;
    }
    if (rows.length < 3) return [];
    const headers = rows[0].split('|').slice(1, -1).map(h => h.trim().toLowerCase());
    return rows.slice(2).map(row => {
        const cells = row.split('|').slice(1, -1).map(c => unescapeCell(c.trim()));
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
        return obj;
    });
}

function buildMdTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length), 3));
    const pad    = (s: string, w: number) => s.padEnd(w);
    const sep    = (w: number) => '-'.repeat(w);
    const header  = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |';
    const divider = '| ' + widths.map(sep).join(' | ') + ' |';
    const body    = rows.map(row =>
        '| ' + headers.map((_, i) => pad(escapeCell(row[i] ?? ''), widths[i])).join(' | ') + ' |'
    );
    return [header, divider, ...body].join('\n');
}

// ─── Per-type parsers and serializers ─────────────────────────────────────────

function parseRoots(content: string): Root[] {
    return parseMdTable(content)
        .map(r => ({
            root:       r['root']     ?? '',
            meaning:    r['meaning']  ?? '',
            category:   r['category'] ?? '',
            notes:      r['notes']    ?? '',
            alternates: (r['alternates'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
        }))
        .filter(r => r.root.trim() !== '');
}

function rootsToMd(roots: Root[]): string {
    return [
        '# Root Lexicon', '',
        'Add roots here or use the Rootweave panel (📖 ribbon icon).', '',
        buildMdTable(
            ['root', 'meaning', 'category', 'notes', 'alternates'],
            roots.map(r => [r.root, r.meaning, r.category, r.notes, r.alternates.join(', ')])
        ),
    ].join('\n');
}

function parseWords(content: string): Word[] {
    return parseMdTable(content)
        .map(r => ({
            word:    r['word']           ?? '',
            meaning: r['meaning']        ?? '',
            pos:     r['part of speech'] ?? '',
            roots:   (r['roots'] ?? '').split('+').map(s => s.trim()).filter(Boolean),
        }))
        .filter(w => w.word.trim() !== '');
}

function wordsToMd(words: Word[]): string {
    return [
        '# Dictionary', '',
        'Add words here or use the Builder tab in the Rootweave panel.', '',
        buildMdTable(
            ['word', 'meaning', 'part of speech', 'roots'],
            words.map(w => [w.word, w.meaning, w.pos, w.roots.join(' + ')])
        ),
    ].join('\n');
}

function parseRules(content: string): Rule[] {
    return parseMdTable(content)
        .map((r): Rule => ({
            name:    r['name']    ?? '',
            type:    (['prefix', 'suffix', 'infix', 'other'].includes(r['type'] ?? ''))
                         ? r['type'] as Rule['type'] : 'suffix',
            form:    r['form']    ?? '',
            meaning: r['meaning'] ?? '',
            example: r['example'] ?? '',
            notes:   r['notes']   ?? '',
        }))
        .filter(r => r.name.trim() !== '');
}

function rulesToMd(rules: Rule[]): string {
    return [
        '# Grammar Rules', '',
        'Each rule describes a morphological construction — a prefix, suffix, or other affix.', '',
        '- **prefix** — added before the word (e.g. on- for past tense)',
        '- **suffix** — added after the word (e.g. -iu for plural)',
        '- **infix** — inserted inside the word',
        '- **other** — freeform rule or particle',
        '',
        buildMdTable(
            ['name', 'type', 'form', 'meaning', 'example', 'notes'],
            rules.map(r => [r.name, r.type, r.form, r.meaning, r.example, r.notes])
        ),
    ].join('\n');
}

// Apply a prefix/suffix rule to a word and return the resulting form
function applyRule(rule: Rule, word: string): string | null {
    const affix = rule.form.replace(/^-|-$/g, ''); // strip display dashes
    if (rule.type === 'prefix') return affix + word;
    if (rule.type === 'suffix') return word + affix;
    return null; // infix/other: too complex to auto-apply
}

// ─── Import parser ────────────────────────────────────────────────────────────
// Converts a template like "[root] - [meaning] ([category])" into a regex,
// then applies it to each line of raw data.

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildParser(template: string, fields: string[]): { regex: RegExp; order: string[] } | null {
    const order: string[] = [];
    let src = '^';
    let last = 0;
    let m: RegExpExecArray | null;
    const re = /\[(\w+)\]/g;
    while ((m = re.exec(template)) !== null) {
        const name = m[1].toLowerCase();
        if (!fields.includes(name)) continue;
        src += escapeRe(template.slice(last, m.index)) + '(.+?)';
        order.push(name);
        last = m.index + m[0].length;
    }
    src += escapeRe(template.slice(last)) + '$';
    if (order.length === 0) return null;
    try { return { regex: new RegExp(src, 'i'), order }; }
    catch { return null; }
}

function importRoots(template: string, text: string): Root[] {
    const p = buildParser(template, ['root', 'alternates', 'meaning', 'category', 'notes']);
    if (!p) return [];
    return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        .flatMap(line => {
            const m = p.regex.exec(line);
            if (!m) return [];
            const d: Record<string, string> = {};
            p.order.forEach((f, i) => { d[f] = m[i + 1].trim(); });
            if (!d['root']) return [];
            return [{
                root:       d['root'],
                meaning:    d['meaning']    ?? '',
                category:   d['category']   ?? '',
                notes:      d['notes']      ?? '',
                alternates: d['alternates'] ? d['alternates'].split(/[,/]/).map(s => s.trim()).filter(Boolean) : [],
            }];
        });
}

function importWords(template: string, text: string): Word[] {
    const p = buildParser(template, ['word', 'meaning', 'pos']);
    if (!p) return [];
    return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        .flatMap(line => {
            const m = p.regex.exec(line);
            if (!m) return [];
            const d: Record<string, string> = {};
            p.order.forEach((f, i) => { d[f] = m[i + 1].trim(); });
            if (!d['word']) return [];
            return [{ word: d['word'], meaning: d['meaning'] ?? '', pos: d['pos'] ?? '', roots: [] }];
        });
}

// Mirror capitalisation of source onto target: "Hello" → Title, "HELLO" → UPPER
function matchCase(source: string, target: string): string {
    if (!source || !target) return target;
    if (source === source.toUpperCase() && /[A-Z]/.test(source)) return target.toUpperCase();
    if (/^[A-Z]/.test(source)) return target[0].toUpperCase() + target.slice(1);
    return target;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class RootweavePlugin extends Plugin {
    settings: Settings;

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE, leaf => new RootweaveView(leaf, this));
        this.addRibbonIcon('book-open', 'Rootweave', () => { void this.openPanel(); });
        this.addCommand({ id: 'open', name: 'Open panel', callback: () => { void this.openPanel(); } });
        this.addSettingTab(new RootweaveSettingTab(this.app, this));
    }

    onunload() {}

    async openPanel() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            const right = workspace.getRightLeaf(false);
            if (right) { await right.setViewState({ type: VIEW_TYPE, active: true }); leaf = right; }
        }
        if (leaf) workspace.setActiveLeaf(leaf, { focus: true });
    }

    // ── Vault I/O ─────────────────────────────────────────────────────────────
    // We use adapter.read/write directly — vault.create/modify can fail silently
    // when Obsidian's in-memory file cache hasn't caught up with recent changes.

    async readFile(path: string): Promise<string | null> {
        try { return await this.app.vault.adapter.read(normalizePath(path)); }
        catch { return null; }
    }

    async writeFile(path: string, content: string): Promise<void> {
        const p = normalizePath(path);
        const dir = p.split('/').slice(0, -1).join('/');
        if (dir) try { await this.app.vault.createFolder(dir); } catch { /* already exists */ }
        await this.app.vault.adapter.write(p, content);
    }

    // ── Data I/O ──────────────────────────────────────────────────────────────

    async loadRoots(): Promise<Root[]>  { const c = await this.readFile(FILES.roots);   return c ? parseRoots(c) : []; }
    async saveRoots(r: Root[]):  Promise<void> { await this.writeFile(FILES.roots,   rootsToMd(r)); }

    async loadWords(): Promise<Word[]>  { const c = await this.readFile(FILES.words);   return c ? parseWords(c) : []; }
    async saveWords(w: Word[]):  Promise<void> { await this.writeFile(FILES.words,   wordsToMd(w)); }

    async loadRules(): Promise<Rule[]>  { const c = await this.readFile(FILES.grammar); return c ? parseRules(c) : DEFAULT_RULES; }
    async saveRules(r: Rule[]):  Promise<void> { await this.writeFile(FILES.grammar, rulesToMd(r)); }

    async reloadView() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
            if (leaf.view instanceof RootweaveView) await leaf.view.reload();
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<Settings>);
    }
    async saveSettings() { await this.saveData(this.settings); }
}

// ─── Panel View ───────────────────────────────────────────────────────────────

type Tab = 'roots' | 'builder' | 'words' | 'grammar' | 'translator' | 'export';

class RootweaveView extends ItemView {
    plugin: RootweavePlugin;
    private tab: Tab = 'roots';
    private roots: Root[] = [];
    private words: Word[] = [];
    private rules: Rule[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: RootweavePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType()    { return VIEW_TYPE; }
    getDisplayText() { return 'Rootweave'; }
    getIcon()        { return 'book-open'; }

    async reload() {
        try {
            [this.roots, this.words, this.rules] = await Promise.all([
                this.plugin.loadRoots(),
                this.plugin.loadWords(),
                this.plugin.loadRules(),
            ]);
        } catch (e) { console.error('Rootweave reload error', e); }
        this.render();
    }

    async onOpen() {
        try {
            [this.roots, this.words, this.rules] = await Promise.all([
                this.plugin.loadRoots(),
                this.plugin.loadWords(),
                this.plugin.loadRules(),
            ]);
            // Auto-create the data files on first open
            const saves: Promise<void>[] = [];
            if (!(await this.plugin.readFile(FILES.roots)))   saves.push(this.plugin.saveRoots(this.roots));
            if (!(await this.plugin.readFile(FILES.words)))   saves.push(this.plugin.saveWords(this.words));
            if (!(await this.plugin.readFile(FILES.grammar))) saves.push(this.plugin.saveRules(this.rules));
            await Promise.allSettled(saves);
        } catch (e) { console.error('Rootweave open error', e); }
        this.render();
    }

    async onClose(): Promise<void> {}

    private render() {
        const el = this.contentEl;
        el.empty();
        el.addClass('rootweave-container');

        el.createEl('div', { cls: 'rw-header' }).createEl('span', { cls: 'rw-title', text: 'Rootweave' });

        const tabBar = el.createEl('div', { cls: 'rw-tab-bar' });
        const body   = el.createEl('div', { cls: 'rw-content' });

        const TABS: { id: Tab; label: string }[] = [
            { id: 'roots',      label: `Roots (${this.roots.length})`   },
            { id: 'builder',    label: 'Builder'                        },
            { id: 'words',      label: `Words (${this.words.length})`   },
            { id: 'grammar',    label: `Grammar (${this.rules.length})` },
            { id: 'translator', label: 'Translate'                      },
            { id: 'export',     label: 'Export'                         },
        ];

        TABS.forEach(t => {
            const btn = tabBar.createEl('button', {
                cls: 'rw-tab-btn' + (this.tab === t.id ? ' is-active' : ''),
                text: t.label,
            });
            btn.addEventListener('click', () => { this.tab = t.id; this.render(); });
        });

        switch (this.tab) {
            case 'roots':      this.renderRoots(body);      break;
            case 'builder':    this.renderBuilder(body);    break;
            case 'words':      this.renderWords(body);      break;
            case 'grammar':    this.renderGrammar(body);    break;
            case 'translator': this.renderTranslator(body); break;
            case 'export':     this.renderExport(body);     break;
        }
    }

    // ── Roots tab ─────────────────────────────────────────────────────────────

    private renderRoots(el: HTMLElement) {
        const ctrl = el.createEl('div', { cls: 'rw-controls' });
        const search = ctrl.createEl('input', { cls: 'rw-input', attr: { type: 'text', placeholder: 'Search…' } });

        const cats = ['All', ...new Set(this.roots.map(r => r.category).filter(Boolean))];
        const catSel = ctrl.createEl('select', { cls: 'rw-select' });
        cats.forEach(c => catSel.createEl('option', { value: c, text: c }));

        ctrl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: '+ Root' })
            .addEventListener('click', () => {
                new RootModal(this.app, null, root => {
                    if (this.roots.some(r => r.root === root.root)) {
                        new Notice(`Root "${root.root}" already exists.`); return;
                    }
                    this.roots.push(root);
                    void this.plugin.saveRoots(this.roots).then(() => this.render());
                }).open();
            });

        const list = el.createEl('div', { cls: 'rw-list' });

        const draw = () => {
            list.empty();
            const q   = search.value.toLowerCase();
            const cat = catSel.value;
            const visible = this.roots.filter(r =>
                (!q || r.root.toLowerCase().includes(q) || r.meaning.toLowerCase().includes(q) || r.notes.toLowerCase().includes(q))
                && (cat === 'All' || r.category === cat)
            );

            if (!visible.length) { list.createEl('p', { cls: 'rw-empty', text: 'No roots found.' }); return; }

            visible.forEach(root => {
                const card = list.createEl('div', { cls: 'rw-card' });
                const info = card.createEl('div', { cls: 'rw-card-info' });
                info.createEl('span', { cls: 'rw-root-text', text: root.root });
                if (root.alternates.length)
                    info.createEl('span', { cls: 'rw-root-alts', text: ` / ${root.alternates.join(' / ')}` });
                info.createEl('span', { cls: 'rw-root-meaning', text: ` — ${root.meaning}` });
                if (root.category) info.createEl('span', { cls: 'rw-badge', text: root.category });
                if (root.notes)    card.createEl('div', { cls: 'rw-root-notes', text: root.notes });

                const acts = card.createEl('div', { cls: 'rw-card-actions' });
                acts.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Edit' })
                    .addEventListener('click', () => {
                        new RootModal(this.app, root, updated => {
                            const i = this.roots.findIndex(r => r.root === root.root);
                            if (i !== -1) this.roots[i] = updated;
                            void this.plugin.saveRoots(this.roots).then(() => this.render());
                        }).open();
                    });
                acts.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: 'Delete' })
                    .addEventListener('click', () => {
                        this.roots = this.roots.filter(r => r.root !== root.root);
                        void this.plugin.saveRoots(this.roots).then(() => this.render());
                    });
            });
        };

        search.addEventListener('input', draw);
        catSel.addEventListener('change', draw);
        draw();
    }

    // ── Builder tab ───────────────────────────────────────────────────────────

    private renderBuilder(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Type a word to see its root components and check grammar.' });
        const wordInput = el.createEl('input', { cls: 'rw-input rw-input-lg', attr: { type: 'text', placeholder: 'Type a word…' } });
        const suggestEl = el.createEl('div', { cls: 'rw-suggestions' });
        const formsEl   = el.createEl('div', { cls: 'rw-grammar-forms' });
        const saveArea  = el.createEl('div', { cls: 'rw-add-word-area' });

        const analyze = () => {
            const word = wordInput.value.trim();
            suggestEl.empty(); formsEl.empty(); saveArea.empty();
            if (!word) return;

            const matched = this.roots.filter(r =>
                [r.root, ...r.alternates].some(f => f.length > 0 && word.toLowerCase().includes(f.toLowerCase()))
            );

            if (matched.length) {
                suggestEl.createEl('p', { cls: 'rw-label', text: 'Root components:' });
                matched.forEach(root => {
                    const row = suggestEl.createEl('div', { cls: 'rw-suggestion-row' });
                    row.createEl('span', { cls: 'rw-root-chip', text: root.root });
                    const alt = root.alternates.find(f => f.length > 0 && word.toLowerCase().includes(f.toLowerCase()));
                    if (alt) row.createEl('span', { cls: 'rw-alt-chip', text: `via "${alt}"` });
                    row.createEl('span', { text: ` → ${root.meaning}` });
                    if (root.category) row.createEl('span', { cls: 'rw-badge rw-badge-sm', text: root.category });
                });
                suggestEl.createEl('p', { cls: 'rw-meaning-hint', text: `Composed meaning: ${matched.map(r => r.meaning).join(' + ')}` });
            } else {
                suggestEl.createEl('p', { cls: 'rw-empty', text: 'No matching roots found.' });
            }

            // Show each grammar rule applied to this word
            if (this.rules.length) {
                formsEl.createEl('p', { cls: 'rw-label', text: 'Grammatical forms:' });
                this.rules.forEach(rule => {
                    const result = applyRule(rule, word);
                    const row = formsEl.createEl('div', { cls: 'rw-form-row' });
                    row.createEl('span', { cls: `rw-badge rw-badge-${rule.type}`, text: rule.name });
                    if (result) {
                        row.createEl('span', { cls: 'rw-form-result', text: result });
                        row.createEl('span', { cls: 'rw-form-meaning', text: `(${rule.meaning})` });
                    } else {
                        row.createEl('span', { cls: 'rw-form-result', text: `${rule.form}  ${word}` });
                        row.createEl('span', { cls: 'rw-form-meaning', text: `(${rule.meaning} — see Grammar tab)` });
                    }
                });
            }

            const existing = this.words.find(w => w.word.toLowerCase() === word.toLowerCase());
            if (existing) {
                const msg = saveArea.createEl('p', { cls: 'rw-ok rw-ok-link', text: `✓ "${word}" is in the dictionary — ${existing.meaning}` });
                msg.title = 'Click to edit';
                msg.addEventListener('click', () => {
                    new WordModal(this.app, existing, updated => {
                        const i = this.words.findIndex(w => w.word === existing.word);
                        if (i !== -1) this.words[i] = updated;
                        void this.plugin.saveWords(this.words).then(() => analyze());
                    }).open();
                });
            } else {
            saveArea.createEl('p', { cls: 'rw-label', text: 'Save to dictionary:' });
            const form      = saveArea.createEl('div', { cls: 'rw-add-word-form' });
            const meaningIn = form.createEl('input', { cls: 'rw-input', attr: { type: 'text', placeholder: 'English meaning' } });
            const posIn     = form.createEl('input', { cls: 'rw-input', attr: { type: 'text', placeholder: 'Part of speech (noun, verb…)' } });
            form.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Add to Dictionary' })
                .addEventListener('click', () => {
                    const meaning = meaningIn.value.trim();
                    if (!meaning) { new Notice('Enter a meaning first.'); return; }
                    this.words.push({ word, meaning, pos: posIn.value.trim(), roots: matched.map(r => r.root) });
                    void this.plugin.saveWords(this.words).then(() => {
                        new Notice(`"${word}" added to dictionary!`);
                        wordInput.value = '';
                        analyze();
                    });
                });
            } // end else (word not yet in dictionary)
        };

        wordInput.addEventListener('input', analyze);
    }

    // ── Words tab ─────────────────────────────────────────────────────────────

    private renderWords(el: HTMLElement) {
        const ctrl   = el.createEl('div', { cls: 'rw-controls' });
        const search = ctrl.createEl('input', { cls: 'rw-input', attr: { type: 'text', placeholder: 'Search words…' } });
        ctrl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: '+ Word' })
            .addEventListener('click', () => {
                new WordModal(this.app, null, word => {
                    if (this.words.some(w => w.word.toLowerCase() === word.word.toLowerCase())) {
                        new Notice(`"${word.word}" is already in the dictionary.`); return;
                    }
                    this.words.push(word);
                    void this.plugin.saveWords(this.words).then(() => this.render());
                }).open();
            });

        const list = el.createEl('div', { cls: 'rw-dict-list' });

        const draw = () => {
            list.empty();
            const q = search.value.toLowerCase();
            const visible = this.words.filter(w =>
                !q || w.word.toLowerCase().includes(q) || w.meaning.toLowerCase().includes(q) || w.pos.toLowerCase().includes(q)
            );

            if (!visible.length) {
                list.createEl('p', { cls: 'rw-empty', text: this.words.length === 0 ? 'No words yet. Use the Builder tab or + Word.' : 'No results.' });
                return;
            }

            const table = list.createEl('table', { cls: 'rw-table' });
            const hRow  = table.createEl('thead').createEl('tr');
            ['Word', 'Meaning', 'PoS', 'Roots', ''].forEach(h => hRow.createEl('th', { text: h }));
            const tbody = table.createEl('tbody');

            visible.forEach(w => {
                const row  = tbody.createEl('tr');
                row.createEl('td', { cls: 'rw-word-cell', text: w.word });
                row.createEl('td', { text: w.meaning });
                row.createEl('td', { text: w.pos });
                row.createEl('td', { text: w.roots.join(', ') });
                const acts = row.createEl('td');
                acts.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Edit' })
                    .addEventListener('click', () => {
                        new WordModal(this.app, w, updated => {
                            const i = this.words.findIndex(w2 => w2.word === w.word);
                            if (i !== -1) this.words[i] = updated;
                            void this.plugin.saveWords(this.words).then(() => draw());
                        }).open();
                    });
                acts.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: '×' })
                    .addEventListener('click', () => {
                        this.words = this.words.filter(w2 => w2.word !== w.word);
                        void this.plugin.saveWords(this.words).then(() => draw());
                    });
            });
        };

        search.addEventListener('input', draw);
        draw();
    }

    // ── Grammar tab ───────────────────────────────────────────────────────────

    private renderGrammar(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Rules are tested against each word in the Builder.' });

        const ctrl = el.createEl('div', { cls: 'rw-controls' });
        ctrl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: '+ Rule' })
            .addEventListener('click', () => {
                new RuleModal(this.app, null, rule => {
                    this.rules.push(rule);
                    void this.plugin.saveRules(this.rules).then(() => this.render());
                }).open();
            });

        const list = el.createEl('div', { cls: 'rw-list' });

        if (!this.rules.length) {
            list.createEl('p', { cls: 'rw-empty', text: 'No grammar rules yet. Add a suffix, prefix, or other construction.' });
            return;
        }

        this.rules.forEach((rule, i) => {
            const card = list.createEl('div', { cls: 'rw-card' });
            const info = card.createEl('div', { cls: 'rw-card-info' });
            info.createEl('span', { cls: 'rw-root-text', text: rule.name });
            info.createEl('span', { cls: `rw-badge rw-badge-${rule.type}`, text: rule.type });
            info.createEl('span', { cls: 'rw-root-chip', text: rule.form });
            info.createEl('span', { cls: 'rw-root-meaning', text: ` — ${rule.meaning}` });
            if (rule.example) card.createEl('div', { cls: 'rw-root-notes', text: `e.g. ${rule.example}` });
            if (rule.notes)   card.createEl('div', { cls: 'rw-root-notes', text: rule.notes });

            const acts = card.createEl('div', { cls: 'rw-card-actions' });
            acts.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Edit' })
                .addEventListener('click', () => {
                    new RuleModal(this.app, rule, updated => {
                        this.rules[i] = updated;
                        void this.plugin.saveRules(this.rules).then(() => this.render());
                    }).open();
                });
            acts.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: 'Delete' })
                .addEventListener('click', () => {
                    this.rules.splice(i, 1);
                    void this.plugin.saveRules(this.rules).then(() => this.render());
                });
        });
    }

    // ── Translator tab ────────────────────────────────────────────────────────

    private renderTranslator(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Translate English → your conlang using the dictionary.' });
        const inputArea    = el.createEl('textarea', { cls: 'rw-textarea', attr: { placeholder: 'Type an English sentence…' } });
        const glossLabel   = el.createEl('label', { cls: 'rw-toggle-label' });
        const glossChk     = glossLabel.createEl('input');
        glossChk.type      = 'checkbox';
        glossLabel.appendText(' Show interlinear gloss');
        const translateBtn = el.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Translate' });
        const outputEl     = el.createEl('div', { cls: 'rw-translator-output' });

        translateBtn.addEventListener('click', () => {
            outputEl.empty();
            const sentence = inputArea.value.trim();
            if (!sentence) return;

            const tokens  = sentence.split(/\s+/);
            const results = tokens.map(token => {
                const m      = token.match(/^([^a-zA-Z]*)([a-zA-Z]*)([^a-zA-Z]*)$/);
                const prefix = m?.[1] ?? '';
                const word   = m?.[2] ?? token;
                const suffix = m?.[3] ?? '';
                const entry  = this.words.find(w =>
                    w.meaning.toLowerCase().split(/[\s,;/]+/).some(p => p.trim() === word.toLowerCase())
                );
                const translated = entry ? matchCase(word, entry.word) : null;
                return { prefix, word, suffix, entry, translated };
            });

            if (glossChk.checked) {
                const gloss    = outputEl.createEl('div', { cls: 'rw-gloss' });
                const origRow  = gloss.createEl('div', { cls: 'rw-gloss-row rw-gloss-original' });
                const transRow = gloss.createEl('div', { cls: 'rw-gloss-row rw-gloss-translation' });
                results.forEach(({ prefix, word, suffix, translated }) => {
                    const orig  = origRow.createEl('span',  { cls: 'rw-gloss-cell', text: prefix + word + suffix });
                    const trans = transRow.createEl('span', { cls: 'rw-gloss-cell' });
                    if (translated) {
                        trans.setText(translated); trans.addClass('rw-gloss-found');
                        orig.title = `→ ${translated}`;
                    } else {
                        trans.setText('?'); trans.addClass('rw-gloss-missing');
                        orig.addClass('rw-unknown-word'); orig.title = 'Not in dictionary';
                    }
                });
            } else {
                const line = outputEl.createEl('div', { cls: 'rw-translation-line' });
                results.forEach(({ prefix, word, suffix, entry, translated }, i) => {
                    if (i > 0) line.appendText(' ');
                    if (prefix) line.appendText(prefix);
                    if (translated) {
                        const s = line.createEl('span', { cls: 'rw-word-found', text: translated });
                        s.title = `${word} → ${entry?.meaning ?? ''}`;
                    } else {
                        const s = line.createEl('span', { cls: 'rw-word-missing', text: word });
                        s.title = 'Not in dictionary';
                    }
                    if (suffix) line.appendText(suffix);
                });
            }

            outputEl.createEl('button', { cls: 'rw-btn rw-btn-sm rw-copy-btn', text: 'Copy' })
                .addEventListener('click', () => {
                    const text = results.map(({ prefix, word, suffix, translated }) => prefix + (translated ?? word) + suffix).join(' ');
                    void navigator.clipboard.writeText(text);
                    new Notice('Copied!');
                });
        });
    }

    // ── Export tab ────────────────────────────────────────────────────────────

    private renderExport(el: HTMLElement) {
        el.createEl('p', { cls: 'rw-subtitle', text: 'Your data already lives in .rootweave/ as Markdown files. Export creates a single consolidated snapshot.' });

        const stats = el.createEl('div', { cls: 'rw-export-stats' });
        stats.createEl('p', { text: `${this.roots.length} root${this.roots.length !== 1 ? 's' : ''}` });
        stats.createEl('p', { text: `${this.words.length} word${this.words.length !== 1 ? 's' : ''}` });
        stats.createEl('p', { text: `${this.rules.length} grammar rule${this.rules.length !== 1 ? 's' : ''}` });

        el.createEl('p', { cls: 'rw-label', text: 'Source files (open directly):' });
        const links = el.createEl('div', { cls: 'rw-file-links' });
        Object.values(FILES).forEach(path => {
            const name = path.split('/').pop() ?? path;
            links.createEl('button', { cls: 'rw-btn rw-btn-sm rw-file-link', text: name })
                .addEventListener('click', () => {
                    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
                    if (file instanceof TFile) void this.app.workspace.getLeaf().openFile(file);
                    else new Notice(`${path} hasn't been created yet — add some data first.`);
                });
        });

        el.createEl('div', { cls: 'rw-divider' });

        el.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Export Snapshot' })
            .addEventListener('click', () => {
                const lang    = this.plugin.settings.language;
                const date    = new Date().toISOString().slice(0, 10);
                const content = [`# ${lang} — ${date}`, '', rootsToMd(this.roots), '', wordsToMd(this.words), '', rulesToMd(this.rules)].join('\n');
                const fname   = `${lang.replace(/\s+/g, '-').toLowerCase()}-${date}.md`;
                const np      = normalizePath(fname);
                const existing = this.app.vault.getAbstractFileByPath(np);
                void (existing instanceof TFile ? this.app.vault.modify(existing, content) : this.app.vault.create(np, content))
                    .then(() => new Notice(`Exported to ${fname}`));
            });
    }
}

// ─── Root Modal ───────────────────────────────────────────────────────────────

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
            const wrap = contentEl.createEl('div', { cls: 'rw-modal-field' });
            wrap.createEl('label', { text: label });
            return wrap.createEl('input', { cls: 'rw-input', attr: { type: 'text', value, placeholder } });
        };

        const rootIn     = field('Root',       this.existing?.root                  ?? '', 'e.g. vel');
        const altsIn     = field('Alternates', this.existing?.alternates.join(', ') ?? '', 'e.g. sight, saw — comma-separated');
        const meaningIn  = field('Meaning',    this.existing?.meaning               ?? '', 'e.g. light, clarity');
        const categoryIn = field('Category',   this.existing?.category              ?? '', 'e.g. element, emotion');
        const notesIn    = field('Notes',      this.existing?.notes                 ?? '', 'Optional');

        const saveBtn = contentEl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Save' });
        saveBtn.addEventListener('click', () => {
            const root = rootIn.value.trim();
            if (!root) { new Notice('Root cannot be empty.'); return; }
            this.onSave({
                root,
                alternates: altsIn.value.split(',').map(s => s.trim()).filter(Boolean),
                meaning:    meaningIn.value.trim(),
                category:   categoryIn.value.trim(),
                notes:      notesIn.value.trim(),
            });
            this.close();
        });

        [rootIn, altsIn, meaningIn, categoryIn, notesIn].forEach(inp =>
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); })
        );
    }

    onClose() { this.contentEl.empty(); }
}

// ─── Word Modal ───────────────────────────────────────────────────────────────

class WordModal extends Modal {
    private existing: Word | null;
    private onSave: (word: Word) => void;

    constructor(app: App, existing: Word | null, onSave: (word: Word) => void) {
        super(app);
        this.existing = existing;
        this.onSave   = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.existing ? 'Edit Word' : 'Add Word' });

        const field = (label: string, value: string, placeholder: string): HTMLInputElement => {
            const wrap = contentEl.createEl('div', { cls: 'rw-modal-field' });
            wrap.createEl('label', { text: label });
            return wrap.createEl('input', { cls: 'rw-input', attr: { type: 'text', value, placeholder } });
        };

        const wordIn    = field('Word',           this.existing?.word                ?? '', 'e.g. veliu');
        const meaningIn = field('Meaning',        this.existing?.meaning             ?? '', 'e.g. lights');
        const posIn     = field('Part of speech', this.existing?.pos                 ?? '', 'noun, verb…');
        const rootsIn   = field('Roots',          this.existing?.roots.join(', ')    ?? '', 'e.g. vel, iu — comma-separated');

        const saveBtn = contentEl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Save' });
        saveBtn.addEventListener('click', () => {
            const word = wordIn.value.trim();
            if (!word) { new Notice('Word cannot be empty.'); return; }
            this.onSave({
                word,
                meaning: meaningIn.value.trim(),
                pos:     posIn.value.trim(),
                roots:   rootsIn.value.split(',').map(s => s.trim()).filter(Boolean),
            });
            this.close();
        });

        [wordIn, meaningIn, posIn, rootsIn].forEach(inp =>
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); })
        );
    }

    onClose() { this.contentEl.empty(); }
}

// ─── Rule Modal ───────────────────────────────────────────────────────────────

class RuleModal extends Modal {
    private existing: Rule | null;
    private onSave: (rule: Rule) => void;

    constructor(app: App, existing: Rule | null, onSave: (rule: Rule) => void) {
        super(app);
        this.existing = existing;
        this.onSave   = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.existing ? 'Edit Rule' : 'Add Rule' });

        const field = (label: string, value: string, placeholder: string): HTMLInputElement => {
            const wrap = contentEl.createEl('div', { cls: 'rw-modal-field' });
            wrap.createEl('label', { text: label });
            return wrap.createEl('input', { cls: 'rw-input', attr: { type: 'text', value, placeholder } });
        };

        const nameIn    = field('Name',    this.existing?.name    ?? '', 'e.g. Plural');
        const formIn    = field('Form',    this.existing?.form    ?? '', 'e.g. -iu  or  on-');
        const meaningIn = field('Meaning', this.existing?.meaning ?? '', 'e.g. plural marker');
        const exampleIn = field('Example', this.existing?.example ?? '', 'e.g. vel → veliu (lights)');
        const notesIn   = field('Notes',   this.existing?.notes   ?? '', 'Optional');

        const typeWrap = contentEl.createEl('div', { cls: 'rw-modal-field' });
        typeWrap.createEl('label', { text: 'Type' });
        const typeSel = typeWrap.createEl('select', { cls: 'rw-select' });
        typeSel.createEl('option', { value: 'prefix',  text: 'prefix — added before the word (e.g. on-)' });
        typeSel.createEl('option', { value: 'suffix',  text: 'suffix — added after the word (e.g. -iu)' });
        typeSel.createEl('option', { value: 'infix',   text: 'infix — inserted inside the word' });
        typeSel.createEl('option', { value: 'other',   text: 'other — freeform rule or particle' });
        if (this.existing?.type) typeSel.value = this.existing.type;

        const saveBtn = contentEl.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Save' });
        saveBtn.addEventListener('click', () => {
            const name = nameIn.value.trim();
            if (!name) { new Notice('Name cannot be empty.'); return; }
            this.onSave({
                name,
                type:    typeSel.value as Rule['type'],
                form:    formIn.value.trim(),
                meaning: meaningIn.value.trim(),
                example: exampleIn.value.trim(),
                notes:   notesIn.value.trim(),
            });
            this.close();
        });

        [nameIn, formIn, meaningIn, exampleIn, notesIn].forEach(inp =>
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

        new Setting(containerEl)
            .setName('Language name')
            .setDesc('Used in export file names and headings.')
            .addText(text => text
                .setPlaceholder('My Conlang')
                .setValue(this.plugin.settings.language)
                .onChange(value => { this.plugin.settings.language = value; void this.plugin.saveSettings(); })
            );

        // ── Import ─────────────────────────────────────────────────────────────
        new Setting(containerEl).setName('Import').setHeading();

        let importType: 'roots' | 'words' = 'roots';
        const ROOT_TOKENS = 'Tokens: [root], [alternates], [meaning], [category], [notes]';
        const WORD_TOKENS = 'Tokens: [word], [meaning], [pos]';

        const tokenHint = containerEl.createEl('p', { cls: 'setting-item-description', text: ROOT_TOKENS });

        new Setting(containerEl)
            .setName('Type')
            .addDropdown(dd => dd
                .addOption('roots', 'Roots')
                .addOption('words', 'Words')
                .setValue('roots')
                .onChange(val => {
                    importType = val as 'roots' | 'words';
                    tokenHint.setText(importType === 'roots' ? ROOT_TOKENS : WORD_TOKENS);
                })
            );

        let templateEl: HTMLInputElement;
        new Setting(containerEl)
            .setName('Format template')
            .setDesc('Arrange tokens to match your data. Each line is parsed against this pattern.')
            .addText(text => {
                text.setPlaceholder('[root] [meaning]').setValue('[root] [meaning]');
                templateEl = text.inputEl;
            });

        let dataEl: HTMLTextAreaElement;
        new Setting(containerEl)
            .setName('Data')
            .setDesc('One entry per line. Lines starting with # are skipped.')
            .addTextArea(ta => {
                ta.setPlaceholder('vel light\nkar fire');
                ta.inputEl.rows = 10;
                ta.inputEl.addClass('rw-import-textarea');
                dataEl = ta.inputEl;
            });

        new Setting(containerEl)
            .addButton(btn => btn.setButtonText('Import').setCta().onClick(() => {
                const tmpl = templateEl?.value.trim() ?? '';
                const data = dataEl?.value.trim()     ?? '';
                if (!tmpl) { new Notice('Enter a format template first.'); return; }
                if (!data) { new Notice('Paste some data to import.'); return; }

                if (importType === 'roots') {
                    const parsed = importRoots(tmpl, data);
                    if (!parsed.length) { new Notice('No lines matched the template — check your format.'); return; }
                    void this.plugin.loadRoots().then(existing => {
                        const merged = [...existing];
                        let added = 0, skipped = 0;
                        for (const r of parsed) {
                            if (merged.some(e => e.root === r.root)) { skipped++; continue; }
                            merged.push(r); added++;
                        }
                        void this.plugin.saveRoots(merged)
                            .then(() => { new Notice(`Imported ${added} root${added !== 1 ? 's' : ''}${skipped ? `, skipped ${skipped}` : ''}.`); void this.plugin.reloadView(); })
                            .catch(e => new Notice(`Save failed: ${e}`));
                    }).catch(e => new Notice(`Load failed: ${e}`));
                } else {
                    const parsed = importWords(tmpl, data);
                    if (!parsed.length) { new Notice('No lines matched the template — check your format.'); return; }
                    void this.plugin.loadWords().then(existing => {
                        const merged = [...existing];
                        let added = 0, skipped = 0;
                        for (const w of parsed) {
                            if (merged.some(e => e.word.toLowerCase() === w.word.toLowerCase())) { skipped++; continue; }
                            merged.push(w); added++;
                        }
                        void this.plugin.saveWords(merged)
                            .then(() => { new Notice(`Imported ${added} word${added !== 1 ? 's' : ''}${skipped ? `, skipped ${skipped}` : ''}.`); void this.plugin.reloadView(); })
                            .catch(e => new Notice(`Save failed: ${e}`));
                    }).catch(e => new Notice(`Load failed: ${e}`));
                }
            }));
    }
}
