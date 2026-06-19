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

const VIEW_TYPE       = 'rootweave-view';
const VIEW_TYPE_GRAPH = 'rootweave-graph';

const FILES = {
    roots:     '.rootweave/Roots.md',
    words:     '.rootweave/Dictionary.md',
    grammar:   '.rootweave/Grammar.md',
    phonology: '.rootweave/Phonology.md',
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

// ─── Phonology types ──────────────────────────────────────────────────────────

interface Phoneme { symbol: string; pron: string; long: boolean; }

interface PhonologyData {
    vowels:     Phoneme[];
    consonants: Phoneme[];
    mode:       'strict' | 'permissive';
    banned:     string[];
    notes:      string;
}

interface Syllable { phonemes: string[]; isOpen: boolean; isHeavy: boolean; }

interface PronEx { word: string; sylls: string[][]; stress: number; }

interface PhonModel {
    E:   Record<string, number[]>;
    mE:  Record<string, number[]>;
    vE:  Record<string, number[]>;
    W1:  number[]; b1: number[];
    W2:  number[]; b2: number[];
    W3:  number[]; b3: number[];
    mW1: number[]; vW1: number[];
    mb1: number[]; vb1: number[];
    mW2: number[]; vW2: number[];
    mb2: number[]; vb2: number[];
    mW3: number[]; vW3: number[];
    mb3: number[]; vb3: number[];
    t:   number;
    version: number;
}

const E_DIM       = 8;
const SYLL_F      = E_DIM + 6;  // features for one syllable (14)
const H1          = 64;          // hidden layer 1 (wider for context window)
const H2          = 32;          // hidden layer 2
const IN          = SYLL_F * 3;  // prev + curr + next context (42)
const MODEL_VER   = 2;           // bump when architecture changes → auto-reinit

const DEFAULT_PHONOLOGY: PhonologyData = {
    vowels: [
        { symbol: 'a', pron: 'ah', long: false },
        { symbol: 'e', pron: 'eh', long: false },
        { symbol: 'i', pron: 'ee', long: false },
        { symbol: 'o', pron: 'oh', long: false },
        { symbol: 'u', pron: 'oo', long: false },
    ],
    consonants: [
        { symbol: 'b', pron: 'b', long: false }, { symbol: 'd', pron: 'd', long: false },
        { symbol: 'f', pron: 'f', long: false }, { symbol: 'g', pron: 'g', long: false },
        { symbol: 'k', pron: 'k', long: false }, { symbol: 'l', pron: 'l', long: false },
        { symbol: 'm', pron: 'm', long: false }, { symbol: 'n', pron: 'n', long: false },
        { symbol: 'r', pron: 'r', long: false }, { symbol: 's', pron: 's', long: false },
        { symbol: 't', pron: 't', long: false }, { symbol: 'v', pron: 'v', long: false },
    ],
    mode: 'strict',
    banned: [],
    notes: '',
};

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

function parsePhonSection(content: string, heading: string): Record<string, string>[] {
    const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
    const m  = re.exec(content);
    return m ? parseMdTable(m[1]) : [];
}

function parsePhonology(content: string): PhonologyData {
    const vowRows  = parsePhonSection(content, 'Vowels');
    const conRows  = parsePhonSection(content, 'Consonants');
    const setRows  = parsePhonSection(content, 'Settings');
    const settings: Record<string, string> = {};
    setRows.forEach(r => { if (r['key']) settings[r['key']] = r['value'] ?? ''; });
    return {
        vowels:     vowRows.map(r => ({ symbol: r['symbol'] ?? '', pron: r['pron'] ?? '', long: r['long'] === 'yes' })).filter(p => p.symbol),
        consonants: conRows.map(r => ({ symbol: r['symbol'] ?? '', pron: r['pron'] ?? '', long: false })).filter(p => p.symbol),
        mode:       settings['mode'] === 'permissive' ? 'permissive' : 'strict',
        banned:     (settings['banned'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
        notes:      settings['notes'] ?? '',
    };
}

function phonologyToMd(p: PhonologyData): string {
    return [
        '# Phonology', '',
        '## Vowels',
        buildMdTable(['symbol', 'pron', 'long'], p.vowels.map(v => [v.symbol, v.pron, v.long ? 'yes' : 'no'])),
        '', '## Consonants',
        buildMdTable(['symbol', 'pron'], p.consonants.map(c => [c.symbol, c.pron])),
        '', '## Settings',
        buildMdTable(['key', 'value'], [
            ['mode',   p.mode],
            ['banned', p.banned.join(', ')],
            ['notes',  p.notes],
        ]),
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

// Replace accented / special characters with plain ASCII equivalents
function stripDiacritics(str: string): string {
    // Manual mappings for characters that don't decompose via NFD
    const manual: Record<string, string> = {
        'æ':'ae','Æ':'AE','œ':'oe','Œ':'OE',
        'ø':'o', 'Ø':'O', 'ł':'l', 'Ł':'L',
        'ß':'ss','ð':'d', 'Ð':'D', 'þ':'th','Þ':'TH',
        'ŋ':'n', 'Ŋ':'N', 'ĸ':'k', 'ŉ':"'n",
    };
    let s = str;
    for (const from of Object.keys(manual)) s = s.split(from).join(manual[from]);
    // NFD splits e.g. é → e + ́, then strip the combining marks
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// NN-assisted suggestion for a missing conlang word.
// Priority: exact root match → partial root match → phonotactic generation.
function suggestConlangWord(
    englishWord: string,
    roots: Root[],
    phon: PhonologyData,
    model: PhonModel | null,
): { form: string; hint: string } {
    const el = englishWord.toLowerCase();
    const meaningsOf = (m: string) => m.toLowerCase().split(/[\s,;/]+/).map(p => p.trim()).filter(Boolean);

    // 1. Exact root meaning / alternate match
    const exactRoot = roots.find(r =>
        meaningsOf(r.meaning).some(p => p === el) ||
        r.alternates.map(a => a.toLowerCase()).indexOf(el) !== -1
    );
    if (exactRoot) return { form: exactRoot.root, hint: `root "${exactRoot.root}" (${exactRoot.meaning})` };

    // 2. Partial root meaning overlap
    const partialRoot = roots.find(r =>
        meaningsOf(r.meaning).some(p => p.length > 2 && (el.includes(p) || p.includes(el)))
    );
    if (partialRoot) return { form: partialRoot.root, hint: `related root "${partialRoot.root}" (${partialRoot.meaning})` };

    // 3. Phonotactically generated word using the inventory (and embedding similarity if model exists)
    const vowels = phon.vowels.map(v => v.symbol);
    const cons   = phon.consonants.map(c => c.symbol);
    if (vowels.length === 0) return { form: '', hint: '' };

    // Weight consonants by embedding similarity to the English word's first letter when possible
    let pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
    if (model && cons.length > 1) {
        const firstLetter = el[0] ?? '';
        const scored = cons.map(c => ({
            c,
            sim: model.E[c] && model.E[firstLetter]
                ? model.E[c].reduce((s, v, i) => s + v * (model.E[firstLetter][i] ?? 0), 0)
                : 0,
        })).sort((a, b) => b.sim - a.sim);
        pick = (arr: string[]) => {
            const top = scored.filter(x => arr.indexOf(x.c) !== -1).slice(0, 3);
            return top.length ? top[Math.floor(Math.random() * top.length)].c : arr[0];
        };
    }

    const sylCount = el.length <= 4 ? 1 : el.length <= 7 ? 2 : 3;
    let generated  = '';
    for (let s = 0; s < sylCount; s++) {
        if (cons.length > 0) generated += pick(cons);
        generated += vowels[Math.floor(Math.random() * vowels.length)];
        if (s < sylCount - 1 && cons.length > 0) generated += pick(cons);
    }
    // Retry once if a banned cluster appears
    if (phon.banned.some(b => b && generated.includes(b))) {
        generated = vowels[Math.floor(Math.random() * vowels.length)];
        for (let s = 0; s < sylCount - 1; s++) {
            if (cons.length > 0) generated += pick(cons);
            generated += vowels[Math.floor(Math.random() * vowels.length)];
        }
    }
    return { form: generated, hint: 'phonotactic suggestion' };
}

// Mirror capitalisation of source onto target: "Hello" → Title, "HELLO" → UPPER
function matchCase(source: string, target: string): string {
    if (!source || !target) return target;
    if (source === source.toUpperCase() && /[A-Z]/.test(source)) return target.toUpperCase();
    if (/^[A-Z]/.test(source)) return target[0].toUpperCase() + target.slice(1);
    return target;
}

// ─── Phonology engine ─────────────────────────────────────────────────────────

// Greedy longest-match tokenizer — handles multi-char phonemes like "th", "ae"
function phonTokenize(word: string, phonemes: Phoneme[]): string[] {
    const syms = phonemes.map(p => p.symbol).sort((a, b) => b.length - a.length);
    const tokens: string[] = [];
    let i = 0;
    while (i < word.length) {
        const match = syms.find(s => word.startsWith(s, i));
        if (match) { tokens.push(match); i += match.length; }
        else        { tokens.push(word[i]); i++; }
    }
    return tokens;
}

// Split token list into syllable groups using CV(C) nucleus-rules
function phonSyllabify(tokens: string[], vowelSet: Set<string>): string[][] {
    if (!tokens.length) return [];
    const sylls: string[][] = [];
    let cur: string[]  = [];
    let hasVowel = false;
    for (let i = 0; i < tokens.length; i++) {
        const isV = vowelSet.has(tokens[i]);
        if (isV && hasVowel) {
            sylls.push(cur); cur = [tokens[i]]; hasVowel = true;
        } else if (!isV && hasVowel) {
            const nextIsV = i + 1 < tokens.length && vowelSet.has(tokens[i + 1]);
            if (nextIsV) { sylls.push(cur); cur = [tokens[i]]; hasVowel = false; }
            else { cur.push(tokens[i]); }
        } else {
            cur.push(tokens[i]);
            if (isV) hasVowel = true;
        }
    }
    if (cur.length) sylls.push(cur);
    return sylls;
}

function makeSyllables(syllTokens: string[][], phon: PhonologyData): Syllable[] {
    const vowelSet = new Set(phon.vowels.map(v => v.symbol));
    return syllTokens.map(phonemes => {
        const isOpen  = phonemes.length > 0 && vowelSet.has(phonemes[phonemes.length - 1]);
        const hasLong = phonemes.some(p => phon.vowels.find(v => v.symbol === p)?.long);
        return { phonemes, isOpen, isHeavy: hasLong || !isOpen };
    });
}

// Render syllables as styled spans — stressed syllable is bold and accent-colored
function renderSyllableDisplay(parent: HTMLElement, syllTokens: string[][], stressIdx: number) {
    syllTokens.forEach((syll, si) => {
        if (si > 0) parent.createEl('span', { cls: 'rw-phon-dot', text: '-' });
        parent.createEl('span', {
            cls: 'rw-phon-syll-display' + (si === stressIdx ? ' is-stressed' : ''),
            text: syll.join(''),
        });
    });
}

// Build a pronunciation notation string using raw phoneme symbols.
// Apostrophe goes before the stressed syllable: vel-'iu
function phonReconstruct(syllTokens: string[][], stressIdx: number): string {
    return syllTokens.map((syll, si) =>
        (si === stressIdx ? "'" : '') + syll.join('')
    ).join('-');
}

// Build a "sounds like" reading using pron labels, e.g. "veh·ee·oo"
function phonPronReading(syllTokens: string[][], stressIdx: number, phon: PhonologyData): string {
    const allPh = [...phon.vowels, ...phon.consonants];
    return syllTokens.map((syll, si) => {
        const reading = syll.map(p => allPh.find(x => x.symbol === p)?.pron ?? p).join('');
        return si === stressIdx ? reading.toUpperCase() : reading;
    }).join('-');
}

// ── Neural network ─────────────────────────────────────────────────────────────

function nnRand(n: number, fi: number, fo: number): number[] {
    const s = Math.sqrt(2 / (fi + fo));
    return Array.from({ length: n }, () => (Math.random() * 2 - 1) * s);
}
function nnZero(n: number): number[] { return Array.from({ length: n }, () => 0); }

// Dense layer: output[j] = b[j] + Σ_i W[i*outD+j] * x[i]
function matVec(W: number[], x: number[], inD: number, outD: number, b: number[]): number[] {
    const out = b.slice();
    for (let i = 0; i < inD; i++)
        for (let j = 0; j < outD; j++)
            out[j] += W[i * outD + j] * x[i];
    return out;
}

function matVecBack(
    delta: number[], x: number[], W: number[], inD: number, outD: number
): { gW: number[]; gb: number[]; dx: number[] } {
    const gW = Array.from({ length: inD * outD }, () => 0);
    const dx = Array.from({ length: inD }, () => 0);
    for (let i = 0; i < inD; i++)
        for (let j = 0; j < outD; j++) {
            gW[i * outD + j] = x[i] * delta[j];
            dx[i] += W[i * outD + j] * delta[j];
        }
    return { gW, gb: delta.slice(), dx };
}

function nnSoftmax(x: number[]): number[] {
    const max = Math.max(...x);
    const e   = x.map(v => Math.exp(v - max));
    const s   = e.reduce((a, b) => a + b, 0) || 1;
    return e.map(v => v / s);
}

function reluBack(delta: number[], preAct: number[]): number[] {
    return delta.map((d, i) => preAct[i] > 0 ? d : 0);
}

function adamStep(param: number[], grad: number[], m: number[], v: number[], t: number, lr = 0.01) {
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const bc1 = 1 - Math.pow(b1, t), bc2 = 1 - Math.pow(b2, t);
    for (let i = 0; i < param.length; i++) {
        m[i] = b1 * m[i] + (1 - b1) * grad[i];
        v[i] = b2 * v[i] + (1 - b2) * grad[i] * grad[i];
        param[i] -= lr * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
    }
}

function newPhonModel(phonemeSymbols: string[]): PhonModel {
    return {
        E:   Object.fromEntries(phonemeSymbols.map(p => [p, nnRand(E_DIM, 1, E_DIM)])),
        mE:  Object.fromEntries(phonemeSymbols.map(p => [p, nnZero(E_DIM)])),
        vE:  Object.fromEntries(phonemeSymbols.map(p => [p, nnZero(E_DIM)])),
        W1: nnRand(IN * H1, IN, H1), b1: nnZero(H1),
        W2: nnRand(H1 * H2, H1, H2), b2: nnZero(H2),
        W3: nnRand(H2,      H2, 1),   b3: nnZero(1),
        mW1: nnZero(IN * H1), vW1: nnZero(IN * H1),
        mb1: nnZero(H1),      vb1: nnZero(H1),
        mW2: nnZero(H1 * H2), vW2: nnZero(H1 * H2),
        mb2: nnZero(H2),      vb2: nnZero(H2),
        mW3: nnZero(H2),      vW3: nnZero(H2),
        mb3: nnZero(1),       vb3: nnZero(1),
        t: 0,
        version: MODEL_VER,
    };
}

function phonGetEmbed(p: string, m: PhonModel): number[] {
    if (!m.E[p])  m.E[p]  = nnRand(E_DIM, 1, E_DIM);
    if (!m.mE[p]) m.mE[p] = nnZero(E_DIM);
    if (!m.vE[p]) m.vE[p] = nnZero(E_DIM);
    return m.E[p];
}

// 14-dim feature vector for one syllable
function syllFeats(syll: Syllable, idx: number, total: number, m: PhonModel): number[] {
    const embeds = syll.phonemes.map(p => phonGetEmbed(p, m));
    const avgEmb = Array.from({ length: E_DIM }, (_, j) =>
        embeds.reduce((s, e) => s + e[j], 0) / (embeds.length || 1)
    );
    let onset = 0;
    for (const _p of syll.phonemes) { if (!syll.isHeavy && onset === 0) break; onset++; }
    return [
        ...avgEmb,
        total > 1 ? idx / (total - 1) : 0,
        total > 1 ? (total - 1 - idx) / (total - 1) : 0,
        Math.min(total / 6, 1),
        syll.isOpen  ? 1 : 0,
        syll.isHeavy ? 1 : 0,
        Math.min(onset / 3, 1),
    ];
}

// 42-dim context window: [prev_feats, curr_feats, next_feats]
// This lets the network learn stress from contrast between syllables, not just each syllable alone.
function contextFeats(sylls: Syllable[], idx: number, m: PhonModel): number[] {
    const n    = sylls.length;
    const zero = Array.from({ length: SYLL_F }, () => 0);
    const prev = idx > 0     ? syllFeats(sylls[idx - 1], idx - 1, n, m) : zero;
    const curr =               syllFeats(sylls[idx],     idx,     n, m);
    const next = idx < n - 1 ? syllFeats(sylls[idx + 1], idx + 1, n, m) : zero;
    return [...prev, ...curr, ...next];
}

// Clip gradient norm to prevent exploding gradients in the wider network
function clipGrad(g: number[], maxNorm = 5): void {
    const norm = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
    if (norm > maxNorm) { const scale = maxNorm / norm; for (let i = 0; i < g.length; i++) g[i] *= scale; }
}

function nnForward(feat: number[], m: PhonModel): { z1: number[]; h1: number[]; z2: number[]; h2: number[]; score: number } {
    const z1 = matVec(m.W1, feat, IN, H1, m.b1);
    const h1 = z1.map(v => Math.max(0, v));
    const z2 = matVec(m.W2, h1,  H1, H2, m.b2);
    const h2 = z2.map(v => Math.max(0, v));
    const z3 = matVec(m.W3, h2,  H2, 1,  m.b3);
    return { z1, h1, z2, h2, score: z3[0] };
}

function predictStress(
    sylls: Syllable[], m: PhonModel
): { probs: number[]; stressIdx: number; confidence: number } {
    if (sylls.length === 1) return { probs: [1], stressIdx: 0, confidence: 1 };
    const scores = sylls.map((_, i) => nnForward(contextFeats(sylls, i, m), m).score);
    const probs  = nnSoftmax(scores);
    const stressIdx = probs.indexOf(Math.max(...probs));
    const H    = -probs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);
    const maxH = Math.log(sylls.length);
    return { probs, stressIdx, confidence: maxH > 0 ? 1 - H / maxH : 1 };
}

function trainOnExample(ex: PronEx, m: PhonModel, phon: PhonologyData, lr = 0.006) {
    const sylls = makeSyllables(ex.sylls, phon);
    if (sylls.length <= 1) return;
    m.t++;
    const feats = sylls.map((_, i) => contextFeats(sylls, i, m));
    const fwds  = feats.map(f => nnForward(f, m));
    const probs = nnSoftmax(fwds.map(f => f.score));
    const dScores = probs.map((p, i) => p - (i === ex.stress ? 1 : 0));

    const aW1 = nnZero(m.W1.length), ab1 = nnZero(m.b1.length);
    const aW2 = nnZero(m.W2.length), ab2 = nnZero(m.b2.length);
    const aW3 = nnZero(m.W3.length), ab3 = nnZero(m.b3.length);
    const aE: Record<string, number[]> = {};

    sylls.forEach((syll, si) => {
        const { z1, h1, z2, h2 } = fwds[si];
        const feat = feats[si];
        const d3 = dScores[si];
        const { gW: gW3, gb: gb3, dx: dh2 } = matVecBack([d3], h2, m.W3, H2, 1);
        const dz2 = reluBack(dh2, z2);
        const { gW: gW2, gb: gb2, dx: dh1 } = matVecBack(dz2, h1, m.W2, H1, H2);
        const dz1 = reluBack(dh1, z1);
        const { gW: gW1, gb: gb1, dx: dFeat } = matVecBack(dz1, feat, m.W1, IN, H1);
        for (let i = 0; i < aW1.length; i++) aW1[i] += gW1[i];
        for (let i = 0; i < ab1.length; i++) ab1[i] += gb1[i];
        for (let i = 0; i < aW2.length; i++) aW2[i] += gW2[i];
        for (let i = 0; i < ab2.length; i++) ab2[i] += gb2[i];
        for (let i = 0; i < aW3.length; i++) aW3[i] += gW3[i];
        for (let i = 0; i < ab3.length; i++) ab3[i] += gb3[i];
        void gb3;
        // Embedding gradient comes from the current-syllable slot (indices SYLL_F..SYLL_F+E_DIM)
        const dEmb = dFeat.slice(SYLL_F, SYLL_F + E_DIM);
        const nP   = syll.phonemes.length || 1;
        syll.phonemes.forEach(p => {
            if (!aE[p]) aE[p] = nnZero(E_DIM);
            dEmb.forEach((d, j) => { aE[p][j] += d / nP; });
        });
    });

    const L2 = 0.0001;
    for (let i = 0; i < aW1.length; i++) aW1[i] += L2 * m.W1[i];
    for (let i = 0; i < aW2.length; i++) aW2[i] += L2 * m.W2[i];
    for (let i = 0; i < aW3.length; i++) aW3[i] += L2 * m.W3[i];

    clipGrad(aW1); clipGrad(aW2); clipGrad(aW3);
    clipGrad(ab1); clipGrad(ab2); clipGrad(ab3);

    adamStep(m.W1, aW1, m.mW1, m.vW1, m.t, lr);
    adamStep(m.b1, ab1, m.mb1, m.vb1, m.t, lr);
    adamStep(m.W2, aW2, m.mW2, m.vW2, m.t, lr);
    adamStep(m.b2, ab2, m.mb2, m.vb2, m.t, lr);
    adamStep(m.W3, aW3, m.mW3, m.vW3, m.t, lr);
    adamStep(m.b3, ab3, m.mb3, m.vb3, m.t, lr);
    Object.entries(aE).forEach(([p, grad]) => {
        phonGetEmbed(p, m);
        clipGrad(grad);
        adamStep(m.E[p], grad, m.mE[p], m.vE[p], m.t, lr * 0.5);
    });
}

// Parse typed stress notation: "'vel-i-u" or "vel-'i-u" → syllable index of stressed part.
// Splits on -, ·, ., or space. Returns null if syllable count doesn't match.
function parseStressNotation(text: string, syllCount: number): number | null {
    const parts = text.trim().split(/[-·.\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length !== syllCount) return null;
    const idx = parts.findIndex(p => p.startsWith("'") || p.startsWith('ˈ'));
    return idx >= 0 ? idx : null;
}

function batchTrain(examples: PronEx[], m: PhonModel, phon: PhonologyData, epochs = 40) {
    for (let ep = 0; ep < epochs; ep++)
        for (const ex of examples)
            trainOnExample(ex, m, phon, 0.008 * (1 - ep / epochs * 0.4));
}

// ── Rhyme helpers ──────────────────────────────────────────────────────────────

// English rhyme key: last vowel cluster + trailing consonants
function englishRhymeKey(word: string): string {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    const vowels = 'aeiouy';
    let i = w.length - 1;
    while (i >= 0 && !vowels.includes(w[i])) i--;   // skip trailing consonants
    while (i > 0  &&  vowels.includes(w[i - 1])) i--; // extend back over vowel cluster
    return i >= 0 ? w.slice(i) : w;
}

// Detect rhyme scheme: returns ['A','A','B','B'] style array
function detectRhymeScheme(keys: string[]): string[] {
    const map = new Map<string, string>();
    let next = 0;
    return keys.map(k => {
        if (!map.has(k)) map.set(k, String.fromCharCode(65 + next++));
        return map.get(k)!;
    });
}

// Conlang rhyme key: phoneme tokens from last-stressed-syllable nucleus onwards
// Returns joined string (e.g. "ela") for exact matching, plus raw tokens for NN scoring
function conlangRhymeKey(
    word: string,
    phon: PhonologyData,
    stressMap: Record<string, number>
): { key: string; tokens: string[] } | null {
    const allPh    = [...phon.vowels, ...phon.consonants];
    const vowelSet = new Set(phon.vowels.map(v => v.symbol));
    if (!allPh.length) return null;
    const tokens     = phonTokenize(word.toLowerCase(), allPh);
    const syllTokens = phonSyllabify(tokens, vowelSet);
    if (!syllTokens.length) return null;
    const stressIdx  = stressMap[word.toLowerCase()] ?? 0;
    const stressed   = syllTokens[Math.min(stressIdx, syllTokens.length - 1)];
    const nucStart   = stressed.findIndex(p => vowelSet.has(p));
    if (nucStart < 0) return null;
    // nucleus + coda of stressed syll + all following syllables
    const rhymeToks  = [
        ...stressed.slice(nucStart),
        ...syllTokens.slice(stressIdx + 1).flat(),
    ];
    return { key: rhymeToks.join(''), tokens: rhymeToks };
}

// NN-based rhyme similarity: cosine similarity of first-vowel embeddings
// Returns 0–1 (1 = identical nucleus, 0 = completely unrelated)
function rhymeSimilarity(a: string[], b: string[], m: PhonModel): number {
    const eA = a.length ? phonGetEmbed(a[0], m) : null;
    const eB = b.length ? phonGetEmbed(b[0], m) : null;
    if (!eA || !eB) return 0;
    const dot  = eA.reduce((s, v, i) => s + v * eB[i], 0);
    const normA = Math.sqrt(eA.reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(eB.reduce((s, v) => s + v * v, 0));
    return normA && normB ? dot / (normA * normB) : 0;
}

// ── PCA for phoneme map ────────────────────────────────────────────────────────

function pca2d(vecs: number[][]): [number, number][] {
    if (vecs.length < 2) return vecs.map(() => [0, 0] as [number, number]);
    const n = vecs.length, d = vecs[0].length;
    const mean = Array.from({ length: d }, (_, j) => vecs.reduce((s, v) => s + v[j], 0) / n);
    const X    = vecs.map(v => v.map((x, j) => x - mean[j]));
    const norm = (u: number[]) => Math.sqrt(u.reduce((s, x) => s + x * x, 0)) || 1;

    function powerIter(data: number[][]): number[] {
        let v = Array.from({ length: d }, () => Math.random() - 0.5);
        v = v.map(x => x / norm(v));
        for (let it = 0; it < 60; it++) {
            const w = data.map(row => row.reduce((s, x, i) => s + x * v[i], 0));
            const r = Array.from({ length: d }, (_, j) => data.reduce((s, row, i) => s + row[j] * w[i], 0));
            v = r.map(x => x / norm(r));
        }
        return v;
    }

    const v1 = powerIter(X);
    const s1  = X.map(row => row.reduce((s, x, i) => s + x * v1[i], 0));
    const X2  = X.map((row, i) => row.map((x, j) => x - s1[i] * v1[j]));
    const v2  = powerIter(X2);
    const s2  = X.map(row => row.reduce((s, x, i) => s + x * v2[i], 0));
    return s1.map((x, i) => [x, s2[i]] as [number, number]);
}

// ── Phonotactics inference ─────────────────────────────────────────────────────

function inferPhono(words: Word[], phon: PhonologyData): string[] {
    if (words.length < 3) return [];
    const allPh    = [...phon.vowels, ...phon.consonants];
    const vowelSet = new Set(phon.vowels.map(v => v.symbol));
    const conSet   = new Set(phon.consonants.map(c => c.symbol));
    const results: string[] = [];
    const tokenized = words
        .map(w => phonTokenize(w.word.toLowerCase(), allPh))
        .filter(t => t.length > 0 && t.every(p => vowelSet.has(p) || conSet.has(p)));
    if (tokenized.length < 3) return [];
    const n     = tokenized.length;
    const endV  = tokenized.filter(t => vowelSet.has(t[t.length - 1])).length;
    const startC = tokenized.filter(t => t.length > 0 && !vowelSet.has(t[0])).length;
    if (endV === n)    results.push(`All ${n} words end in a vowel`);
    else if (endV === 0) results.push('No words end in a vowel');
    if (startC === n)  results.push(`All ${n} words start with a consonant`);
    let maxCluster = 0;
    for (const t of tokenized) {
        let run = 0;
        for (const p of t) { run = vowelSet.has(p) ? 0 : run + 1; maxCluster = Math.max(maxCluster, run); }
    }
    if (maxCluster <= 1) results.push('No consonant clusters observed');
    else results.push(`Largest consonant cluster: ${maxCluster}`);
    const sylls = tokenized.map(t => phonSyllabify(t, vowelSet).length);
    const maxS  = Math.max(...sylls);
    const avgS  = (sylls.reduce((a, b) => a + b, 0) / n).toFixed(1);
    results.push(`Syllables per word: max ${maxS}, avg ${avgS}`);
    return results;
}

// ─── Graph types and layout ───────────────────────────────────────────────────

interface GNode {
    id: string;
    kind: 'root' | 'word';
    label: string;
    sub: string;   // meaning
    tag: string;   // category or pos
    x: number; y: number;
    vx: number; vy: number;
}

interface GEdge { src: string; tgt: string; }

// Basic force-directed layout — runs a fixed number of iterations then stops.
// Good enough for conlang-sized graphs (tens to low hundreds of nodes).
function forceLayout(nodes: GNode[], edges: GEdge[], W: number, H: number) {
    nodes.forEach((n, i) => {
        const a = (2 * Math.PI * i) / nodes.length;
        n.x  = W / 2 + Math.cos(a) * Math.min(W, H) * 0.35;
        n.y  = H / 2 + Math.sin(a) * Math.min(W, H) * 0.35;
        n.vx = 0; n.vy = 0;
    });

    const map = new Map(nodes.map(n => [n.id, n]));

    for (let t = 0; t < 280; t++) {
        const damp = 0.9 - 0.5 * (t / 280);

        // Node-to-node repulsion
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                const dx = (b.x - a.x) || 0.01;
                const dy = (b.y - a.y) || 0.01;
                const d2 = Math.max(dx * dx + dy * dy, 1);
                const f = 4000 / d2;
                a.vx -= (dx / Math.sqrt(d2)) * f;
                a.vy -= (dy / Math.sqrt(d2)) * f;
                b.vx += (dx / Math.sqrt(d2)) * f;
                b.vy += (dy / Math.sqrt(d2)) * f;
            }
        }

        // Edge spring attraction
        edges.forEach(e => {
            const a = map.get(e.src), b = map.get(e.tgt);
            if (!a || !b) return;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d  = Math.sqrt(dx * dx + dy * dy) || 1;
            const f  = (d - 90) * 0.07;
            a.vx += (dx / d) * f; a.vy += (dy / d) * f;
            b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        });

        // Soft gravity toward center
        nodes.forEach(n => {
            n.vx += (W / 2 - n.x) * 0.006;
            n.vy += (H / 2 - n.y) * 0.006;
            n.x   = Math.max(24, Math.min(W - 24, n.x + n.vx * damp));
            n.y   = Math.max(24, Math.min(H - 24, n.y + n.vy * damp));
            n.vx *= damp; n.vy *= damp;
        });
    }
}

const SVGNS = 'http://www.w3.org/2000/svg';
const mksvg  = (tag: string) => activeDocument.createElementNS(SVGNS, tag);

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class RootweavePlugin extends Plugin {
    settings: Settings;
    phonModel:    PhonModel | null = null;
    phonExamples: PronEx[]        = [];
    wordStress:   Record<string, number> = {};

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE,       leaf => new RootweaveView(leaf, this));
        this.registerView(VIEW_TYPE_GRAPH, leaf => new GraphView(leaf, this));
        this.addRibbonIcon('book-open', 'Rootweave', () => { void this.openPanel(); });
        this.addCommand({ id: 'open',       name: 'Open panel',      callback: () => { void this.openPanel(); } });
        this.addCommand({ id: 'open-graph', name: 'Open root graph', callback: () => { void this.openGraph(); } });
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

    async openGraph() {
        const { workspace } = this.app;
        // Re-use an existing graph leaf if one is already open
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_GRAPH)[0];
        if (!leaf) {
            leaf = workspace.getLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_GRAPH, active: true });
        }
        workspace.setActiveLeaf(leaf, { focus: true });
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

    async loadPhonology(): Promise<PhonologyData> {
        const c = await this.readFile(FILES.phonology);
        return c ? parsePhonology(c) : { ...DEFAULT_PHONOLOGY };
    }
    async savePhonology(p: PhonologyData): Promise<void> { await this.writeFile(FILES.phonology, phonologyToMd(p)); }

    async reloadView() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
            if (leaf.view instanceof RootweaveView) await leaf.view.reload();
    }

    // ── Settings (includes phonModel / phonExamples in pluginData) ────────────

    async loadSettings() {
        const data = (await this.loadData() as Record<string, unknown>) ?? {};
        this.settings     = { language: (data['language'] as string) ?? DEFAULT_SETTINGS.language };
        this.phonExamples = (data['phonExamples'] as PronEx[] | undefined) ?? [];
        // wordStress is the authoritative word→stress override table.
        // Migrate from phonExamples if wordStress hasn't been saved yet.
        const savedWS = data['wordStress'] as Record<string, number> | undefined;
        if (savedWS) {
            this.wordStress = savedWS;
        } else {
            this.wordStress = {};
            for (const ex of this.phonExamples) this.wordStress[ex.word] = ex.stress;
        }
        const saved = (data['phonModel'] as PhonModel | null | undefined) ?? null;
        // Discard models from older architectures — examples are kept and will retrain
        this.phonModel = (saved && saved.version === MODEL_VER) ? saved : null;
    }

    async saveSettings() {
        await this.saveData({
            language:     this.settings.language,
            phonModel:    this.phonModel,
            phonExamples: this.phonExamples,
            wordStress:   this.wordStress,
        });
    }
}

// ─── Panel View ───────────────────────────────────────────────────────────────

type Tab = 'roots' | 'builder' | 'words' | 'grammar' | 'translator' | 'export' | 'phonology';

class RootweaveView extends ItemView {
    plugin: RootweavePlugin;
    private tab: Tab = 'roots';
    private roots: Root[] = [];
    private words: Word[] = [];
    private rules: Rule[] = [];
    private phon:  PhonologyData = { ...DEFAULT_PHONOLOGY };

    constructor(leaf: WorkspaceLeaf, plugin: RootweavePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType()    { return VIEW_TYPE; }
    getDisplayText() { return 'Rootweave'; }
    getIcon()        { return 'book-open'; }

    async reload() {
        try {
            [this.roots, this.words, this.rules, this.phon] = await Promise.all([
                this.plugin.loadRoots(),
                this.plugin.loadWords(),
                this.plugin.loadRules(),
                this.plugin.loadPhonology(),
            ]);
        } catch (e) { console.error('Rootweave reload error', e); }
        this.render();
    }

    async onOpen() {
        try {
            [this.roots, this.words, this.rules, this.phon] = await Promise.all([
                this.plugin.loadRoots(),
                this.plugin.loadWords(),
                this.plugin.loadRules(),
                this.plugin.loadPhonology(),
            ]);
            const saves: Promise<void>[] = [];
            if (!(await this.plugin.readFile(FILES.roots)))     saves.push(this.plugin.saveRoots(this.roots));
            if (!(await this.plugin.readFile(FILES.words)))     saves.push(this.plugin.saveWords(this.words));
            if (!(await this.plugin.readFile(FILES.grammar)))   saves.push(this.plugin.saveRules(this.rules));
            if (!(await this.plugin.readFile(FILES.phonology))) saves.push(this.plugin.savePhonology(this.phon));
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
            { id: 'phonology',  label: 'Phonology'                      },
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
            case 'phonology':  this.renderPhonology(body);  break;
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
        const phonEl    = el.createEl('div', { cls: 'rw-phon-breakdown' });
        const formsEl   = el.createEl('div', { cls: 'rw-grammar-forms' });
        const saveArea  = el.createEl('div', { cls: 'rw-add-word-area' });

        const analyze = () => {
            const word = wordInput.value.trim();
            suggestEl.empty(); phonEl.empty(); formsEl.empty(); saveArea.empty();
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

            // Phoneme breakdown (only when phonology inventory is set up)
            const allPhonemes = [...this.phon.vowels, ...this.phon.consonants];
            if (allPhonemes.length > 0) {
                const vowelSet = new Set(this.phon.vowels.map(v => v.symbol));
                const tokens   = phonTokenize(word.toLowerCase(), allPhonemes);
                const knownSet = new Set(allPhonemes.map(p => p.symbol));
                const unknown  = tokens.filter(p => !knownSet.has(p));
                const syllTokens = phonSyllabify(tokens, vowelSet);
                const sylls      = makeSyllables(syllTokens, this.phon);

                if (tokens.length > 0) {
                    phonEl.createEl('p', { cls: 'rw-label', text: 'Phoneme breakdown:' });
                    const breakRow = phonEl.createEl('div', { cls: 'rw-phon-break' });
                    syllTokens.forEach((syll, si) => {
                        if (si > 0) breakRow.createEl('span', { cls: 'rw-phon-dot', text: ' · ' });
                        syll.forEach(p => {
                            const ph = allPhonemes.find(x => x.symbol === p);
                            const sp = breakRow.createEl('span', { cls: ph ? 'rw-phon-token' : 'rw-phon-unknown', text: p });
                            if (ph) sp.title = ph.pron;
                        });
                    });

                    const model = this.plugin.phonModel;
                    if (model && sylls.length > 0 && this.plugin.phonExamples.length >= 2) {
                        const { stressIdx, confidence } = predictStress(sylls, model);
                        const reading = phonPronReading(syllTokens, stressIdx, this.phon);
                        const confPct = Math.round(confidence * 100);
                        const confCls = confidence > 0.75 ? 'rw-conf-high' : confidence > 0.45 ? 'rw-conf-mid' : 'rw-conf-low';
                        const pronRow = phonEl.createEl('div', { cls: 'rw-phon-pron-row' });
                        renderSyllableDisplay(pronRow, syllTokens, stressIdx);
                        pronRow.createEl('span', { cls: 'rw-phon-reading', text: reading });
                        pronRow.createEl('span', { cls: `rw-conf ${confCls}`, text: `${confPct}%` });

                        if (sylls.length > 1) {
                            const stressRow = phonEl.createEl('div', { cls: 'rw-phon-stress-row' });
                            stressRow.createEl('span', { cls: 'rw-label', text: 'Stress: ' });
                            syllTokens.forEach((syll, si) => {
                                const btn = stressRow.createEl('button', {
                                    cls: 'rw-btn rw-btn-sm rw-phon-syll' + (si === stressIdx ? ' is-stressed' : ''),
                                    text: syll.join(''),
                                });
                                btn.title = 'Click to correct stress';
                                btn.addEventListener('click', () => {
                                    const ex: PronEx = { word: word.toLowerCase(), sylls: syllTokens, stress: si };
                                    this.plugin.phonExamples.push(ex);
                                    const m = this.plugin.phonModel ?? newPhonModel(allPhonemes.map(p => p.symbol));
                                    this.plugin.phonModel = m;
                                    for (let ep = 0; ep < 8; ep++) trainOnExample(ex, m, this.phon);
                                    void this.plugin.saveSettings();
                                    analyze();
                                });
                            });
                        }
                    } else if (sylls.length > 1) {
                        const needed = Math.max(0, 2 - this.plugin.phonExamples.length);
                        phonEl.createEl('p', { cls: 'rw-empty rw-phon-hint', text: needed > 0
                            ? `Mark stress on ${needed} more word${needed !== 1 ? 's' : ''} in the Phonology tab to enable predictions.`
                            : 'Go to Phonology → Try a word to train stress prediction.' });
                    }

                    if (this.phon.mode === 'strict' && unknown.length > 0) {
                        phonEl.createEl('p', { cls: 'rw-phon-warn', text: `Unknown sounds: ${[...new Set(unknown)].join(', ')} — add them in the Phonology tab` });
                    }
                }
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
        el.createEl('p', { cls: 'rw-subtitle', text: 'Translate using your dictionary and roots.' });

        // ── Direction toggle ──────────────────────────────────────────────────
        let direction: 'forward' | 'reverse' = 'forward';
        const dirRow  = el.createEl('div', { cls: 'rw-mode-row' });
        const btnFwd  = dirRow.createEl('button', { cls: 'rw-mode-btn is-active', text: 'English → Conlang' });
        const btnRev  = dirRow.createEl('button', { cls: 'rw-mode-btn',           text: 'Conlang → English' });
        const setDir  = (d: 'forward' | 'reverse') => {
            direction = d;
            btnFwd.toggleClass('is-active', d === 'forward');
            btnRev.toggleClass('is-active', d === 'reverse');
            inputArea.setAttribute('placeholder',
                d === 'forward' ? 'Type English text or a poem…' : 'Type conlang text…');
        };
        btnFwd.addEventListener('click', () => setDir('forward'));
        btnRev.addEventListener('click', () => setDir('reverse'));

        const inputArea    = el.createEl('textarea', { cls: 'rw-textarea', attr: { placeholder: 'Type English text or a poem…' } });
        const glossLabel   = el.createEl('label', { cls: 'rw-toggle-label' });
        const glossChk     = glossLabel.createEl('input');
        glossChk.type      = 'checkbox';
        glossLabel.appendText(' Show interlinear gloss');
        const translateBtn = el.createEl('button', { cls: 'rw-btn rw-btn-primary', text: 'Translate' });
        const outputEl     = el.createEl('div', { cls: 'rw-translator-output' });
        const quickAddEl   = el.createEl('div', { cls: 'rw-quick-add-panel' });

        // Shared quick-add form — shown below output when a missing word is clicked
        const showQuickAdd = (englishWord: string, doTranslate: () => void) => {
            quickAddEl.empty();
            const { form: suggested, hint } = suggestConlangWord(
                englishWord, this.roots, this.phon, this.plugin.phonModel
            );
            const panel  = quickAddEl.createEl('div', { cls: 'rw-qa-inner' });
            panel.createEl('span', { cls: 'rw-qa-label', text: `Add "${englishWord}" →` });
            const formIn = panel.createEl('input', {
                cls: 'rw-input rw-qa-input',
                attr: { type: 'text', value: suggested, placeholder: 'conlang word' },
            });
            const posSel = panel.createEl('select', { cls: 'rw-qa-pos' });
            ['noun','verb','adj','adv','other'].forEach(p =>
                posSel.createEl('option', { value: p, text: p })
            );
            if (hint) panel.createEl('span', { cls: 'rw-qa-hint', text: `💡 ${hint}` });

            const saveBtn = panel.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-primary', text: 'Save' });
            const skipBtn = panel.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Skip' });
            skipBtn.addEventListener('click', () => quickAddEl.empty());
            saveBtn.addEventListener('click', () => {
                const wordForm = formIn.value.trim();
                if (!wordForm) { new Notice('Enter a conlang form first.'); return; }
                const newWord: Word = { word: wordForm, meaning: englishWord, pos: posSel.value, roots: [] };
                this.words.push(newWord);
                void this.plugin.saveWords(this.words).then(() => {
                    new Notice(`Saved "${wordForm}" → ${englishWord}`);
                    quickAddEl.empty();
                    doTranslate();
                });
            });
            formIn.focus();
            formIn.select();
        };

        const doTranslate = () => {
            outputEl.empty();
            quickAddEl.empty();
            const fullInput = inputArea.value.trim();
            if (!fullInput) return;

            // Unified dictionary: words + roots, both directions
            type DictEntry = { conlang: string; meaning: string };
            const dict: DictEntry[] = [
                ...this.words.map(w => ({ conlang: w.word, meaning: w.meaning })),
                ...this.roots.map(r => ({ conlang: r.root, meaning: r.meaning })),
            ];

            // Strip leading/trailing punctuation from a token, keep the word core
            const splitToken = (token: string) => {
                const m = token.match(/^([^a-zA-ZÀ-ɏ]*)(.+?)([^a-zA-ZÀ-ɏ]*)$/);
                return m ? { prefix: m[1], word: m[2], suffix: m[3] } : { prefix: '', word: token, suffix: '' };
            };

            type TokenResult = { prefix: string; word: string; suffix: string; meaning: string; translated: string | null };

            const translateToken = (token: string): TokenResult => {
                const { prefix, word, suffix } = splitToken(token);
                if (direction === 'forward') {
                    const wl    = word.toLowerCase();
                    const entry = dict.find(d =>
                        d.meaning.toLowerCase().split(/[\s,;/]+/).map(p => p.trim()).some(p => p === wl)
                    );
                    return { prefix, word, suffix, meaning: entry?.meaning ?? '', translated: entry ? matchCase(word, entry.conlang) : null };
                } else {
                    const wl    = word.toLowerCase();
                    const entry = dict.find(d => d.conlang.toLowerCase() === wl);
                    return { prefix, word, suffix, meaning: entry?.meaning ?? '', translated: entry ? entry.meaning : null };
                }
            };

            const inputLines  = fullInput.split(/\r?\n/);
            const lineResults: TokenResult[][] = inputLines.map(line =>
                line.trim() === '' ? [] : line.split(/\s+/).map(translateToken)
            );

            // ── Confidence score ──────────────────────────────────────────────
            const allTokens  = ([] as TokenResult[]).concat(...lineResults);
            const realWords  = allTokens.filter((t: TokenResult) => t.word.length > 0);
            const foundWords = realWords.filter((t: TokenResult) => t.translated !== null);
            const pct        = realWords.length ? Math.round(foundWords.length / realWords.length * 100) : 100;
            const confCls    = pct >= 85 ? 'rw-conf-high' : pct >= 60 ? 'rw-conf-mid' : 'rw-conf-low';
            const confRow    = outputEl.createEl('div', { cls: 'rw-trans-conf-row' });
            confRow.createEl('span', { cls: `rw-conf ${confCls}`, text: `${pct}% coverage` });
            confRow.createEl('span', { cls: 'rw-trans-conf-detail', text: ` — ${foundWords.length} of ${realWords.length} words found` });

            // ── Render lines ──────────────────────────────────────────────────
            const linesWrap = outputEl.createEl('div', { cls: 'rw-trans-lines' });

            lineResults.forEach((results, li) => {
                if (results.length === 0) { linesWrap.createEl('div', { cls: 'rw-trans-blank' }); return; }

                if (glossChk.checked) {
                    const gloss    = linesWrap.createEl('div', { cls: 'rw-gloss' });
                    const origRow  = gloss.createEl('div', { cls: 'rw-gloss-row rw-gloss-original' });
                    const transRow = gloss.createEl('div', { cls: 'rw-gloss-row rw-gloss-translation' });
                    results.forEach(({ prefix, word, suffix, translated }) => {
                        const orig  = origRow.createEl('span',  { cls: 'rw-gloss-cell', text: prefix + word + suffix });
                        const trans = transRow.createEl('span', { cls: 'rw-gloss-cell' });
                        if (translated) {
                            trans.setText(translated); trans.addClass('rw-gloss-found');
                            orig.title = `→ ${translated}`;
                        } else {
                            trans.setText(direction === 'forward' ? '+ add' : '?');
                            trans.addClass('rw-gloss-missing');
                            orig.addClass('rw-unknown-word'); orig.title = 'Not in dictionary';
                            if (direction === 'forward')
                                trans.addEventListener('click', () => showQuickAdd(word, doTranslate));
                        }
                    });
                } else {
                    const lineEl = linesWrap.createEl('div', { cls: 'rw-translation-line', attr: { 'data-line': String(li) } });
                    results.forEach(({ prefix, word, suffix, meaning, translated }, i) => {
                        if (i > 0) lineEl.appendText(' ');
                        if (prefix) lineEl.appendText(prefix);
                        if (translated) {
                            const s = lineEl.createEl('span', { cls: 'rw-word-found', text: translated });
                            s.title = `${word} → ${meaning}`;
                        } else if (direction === 'forward') {
                            const s = lineEl.createEl('span', { cls: 'rw-word-missing rw-word-addable', text: word });
                            s.title = 'Click to add to dictionary';
                            s.addEventListener('click', () => showQuickAdd(word, doTranslate));
                        } else {
                            const s = lineEl.createEl('span', { cls: 'rw-word-missing', text: word });
                            s.title = 'Not in dictionary';
                        }
                        if (suffix) lineEl.appendText(suffix);
                    });
                }
            });

            // ── Rhyme analysis (forward, multi-line only) ─────────────────────
            const nonEmptyLines = lineResults.filter(l => l.length > 0);
            if (direction === 'forward' && nonEmptyLines.length >= 2) {
                const nonEmptySrcLines = inputLines.filter(l => l.trim() !== '');
                const srcLastWords     = nonEmptyLines.map((_, li) => {
                    const toks = (nonEmptySrcLines[li] ?? '').trim().split(/\s+/);
                    return (toks[toks.length - 1] ?? '').replace(/[^a-zA-Z]/g, '');
                });
                const srcRhymeKeys = srcLastWords.map(w => englishRhymeKey(w));
                const srcScheme    = detectRhymeScheme(srcRhymeKeys);
                const hasRhyme     = new Set(srcScheme).size < srcScheme.length;

                if (hasRhyme) {
                    const phon      = this.phon;
                    const stressMap = this.plugin.wordStress;
                    const model     = this.plugin.phonModel;
                    const hasPhon   = phon.vowels.length > 0 || phon.consonants.length > 0;

                    const transLastWords = nonEmptyLines.map(results => {
                        for (let i = results.length - 1; i >= 0; i--)
                            if (results[i].translated) return results[i].translated!;
                        return null;
                    });
                    const transRhymeData = transLastWords.map(w =>
                        w && hasPhon ? conlangRhymeKey(w, phon, stressMap) : null
                    );
                    const transScheme = detectRhymeScheme(
                        transRhymeData.map(d => d?.key || `__${Math.random()}`)
                    );

                    const rhymeSection = outputEl.createEl('div', { cls: 'rw-rhyme-section' });
                    rhymeSection.createEl('div', { cls: 'rw-label', text: 'Rhyme analysis' });
                    const schemeRow = rhymeSection.createEl('div', { cls: 'rw-rhyme-row' });
                    schemeRow.createEl('span', { cls: 'rw-rhyme-label', text: 'Source:' });
                    schemeRow.createEl('span', { cls: 'rw-rhyme-scheme', text: srcScheme.join(' ') });
                    schemeRow.createEl('span', { cls: 'rw-rhyme-label', text: 'Translation:' });

                    if (!hasPhon) {
                        schemeRow.createEl('span', { cls: 'rw-conf rw-conf-low', text: 'set up phonology to check' });
                    } else {
                        const lineMatches = srcScheme.map((srcLetter, i) => {
                            if (!transRhymeData[i]) return null;
                            const sibling = srcScheme.findIndex((l, j) => l === srcLetter && j !== i);
                            if (sibling < 0) return true;
                            return transScheme[i] === transScheme[sibling];
                        });

                        const schemeSpan = schemeRow.createEl('span', { cls: 'rw-rhyme-scheme' });
                        srcScheme.forEach((_l, i) => {
                            const match = lineMatches[i];
                            const cls   = match === false ? 'rw-rhyme-letter rw-rhyme-break'
                                        : match === true  ? 'rw-rhyme-letter rw-rhyme-ok'
                                        :                   'rw-rhyme-letter rw-rhyme-unknown';
                            schemeSpan.createEl('span', { cls, text: transScheme[i] });
                            if (i < srcScheme.length - 1) schemeSpan.appendText(' ');
                        });

                        lineMatches.forEach((match, i) => {
                            if (match !== false) return;
                            const srcLetter  = srcScheme[i];
                            const siblingIdx = lineMatches.findIndex((m, j) => m === true && srcScheme[j] === srcLetter);
                            const targetData = siblingIdx >= 0 ? transRhymeData[siblingIdx] : null;
                            const engWord    = srcLastWords[i];
                            const brokenWord = transLastWords[i] ?? '';

                            const candidates = dict
                                .filter(d => d.meaning.toLowerCase().split(/[\s,;/]+/).map(p => p.trim()).some(p => p === engWord.toLowerCase()))
                                .filter(d => d.conlang.toLowerCase() !== brokenWord.toLowerCase())
                                .map(d => {
                                    const rk    = conlangRhymeKey(d.conlang, phon, stressMap);
                                    const exact = rk && targetData ? rk.key === targetData.key : false;
                                    const sim   = rk && targetData && model
                                        ? rhymeSimilarity(rk.tokens, targetData.tokens, model) : 0;
                                    return { word: d.conlang, exact, sim };
                                })
                                .sort((a, b) => (b.exact ? 1 : b.sim) - (a.exact ? 1 : a.sim))
                                .slice(0, 3);

                            const fixRow = rhymeSection.createEl('div', { cls: 'rw-rhyme-fix-row' });
                            const endStr = brokenWord ? ` "${brokenWord}"` : '';
                            fixRow.createEl('span', { cls: 'rw-rhyme-fix-label',
                                text: `Line ${i + 1}${endStr} breaks rhyme (${srcLetter})` });
                            if (candidates.length > 0) {
                                fixRow.appendText(' — try: ');
                                candidates.forEach((c, ci) => {
                                    if (ci > 0) fixRow.appendText(', ');
                                    const badge = c.exact ? '✓' : `${Math.round(c.sim * 100)}%`;
                                    fixRow.createEl('span', {
                                        cls: 'rw-rhyme-alt' + (c.exact ? ' rw-rhyme-alt-exact' : ''),
                                        text: `${c.word} (${badge})`,
                                    });
                                });
                            } else {
                                fixRow.appendText(' — no alternatives in dictionary');
                            }
                        });
                    }
                }
            }

            // ── Copy ─────────────────────────────────────────────────────────
            outputEl.createEl('button', { cls: 'rw-btn rw-btn-sm rw-copy-btn', text: 'Copy' })
                .addEventListener('click', () => {
                    const text = lineResults
                        .map(r => r.map(({ prefix, word, suffix, translated }) =>
                            prefix + (translated ?? word) + suffix).join(' '))
                        .join('\n');
                    void navigator.clipboard.writeText(text);
                    new Notice('Copied!');
                });
        };

        translateBtn.addEventListener('click', doTranslate);
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

        el.createEl('button', { cls: 'rw-btn', text: 'Open Root Graph' })
            .addEventListener('click', () => { void this.plugin.openGraph(); });

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

    // ── Phonology tab ─────────────────────────────────────────────────────────

    private renderPhonology(el: HTMLElement) {
        // Auto-retrain after architecture upgrade (model discarded but examples kept)
        if (!this.plugin.phonModel && this.plugin.phonExamples.length > 0) {
            const allPh = [...this.phon.vowels, ...this.phon.consonants];
            const m = newPhonModel(allPh.map(p => p.symbol));
            this.plugin.phonModel = m;
            batchTrain(this.plugin.phonExamples, m, this.phon, 60);
            void this.plugin.saveSettings();
        }

        const savePhon = () => { void this.plugin.savePhonology(this.phon); };

        const renderPhonRow = (
            parent: HTMLElement,
            ph: Phoneme,
            isVowel: boolean,
            onChange: () => void,
            onDelete: () => void
        ) => {
            const row    = parent.createEl('div', { cls: 'rw-phon-row' });
            const symIn  = row.createEl('input', { cls: 'rw-input rw-phon-sym',  attr: { type: 'text', value: ph.symbol, placeholder: 'ph' } });
            const pronIn = row.createEl('input', { cls: 'rw-input rw-phon-pron', attr: { type: 'text', value: ph.pron,   placeholder: 'sound' } });
            symIn.addEventListener('change',  () => { ph.symbol = symIn.value.trim(); onChange(); });
            pronIn.addEventListener('change', () => { ph.pron   = pronIn.value.trim(); onChange(); });
            if (isVowel) {
                const lbl = row.createEl('label', { cls: 'rw-phon-long-label' });
                const chk = lbl.createEl('input');
                chk.type = 'checkbox'; chk.checked = ph.long;
                lbl.appendText(' long');
                chk.addEventListener('change', () => { ph.long = chk.checked; onChange(); });
            }
            row.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger', text: '×' }).addEventListener('click', onDelete);
        };

        // ── Vowels ────────────────────────────────────────────────────────────
        const vowSection = el.createEl('div', { cls: 'rw-phon-section' });
        vowSection.createEl('p', { cls: 'rw-label', text: 'Vowels' });
        vowSection.createEl('p', { cls: 'rw-subtitle', text: 'Symbol = how you type it, Sound = how to say it (e.g. "ah", "/a/").' });
        const vowList = vowSection.createEl('div', { cls: 'rw-phon-list' });

        const redrawVowels = () => {
            vowList.empty();
            this.phon.vowels.forEach((ph, i) =>
                renderPhonRow(vowList, ph, true,
                    savePhon,
                    () => { this.phon.vowels.splice(i, 1); savePhon(); redrawVowels(); }
                )
            );
        };
        redrawVowels();
        vowSection.createEl('button', { cls: 'rw-btn rw-btn-sm', text: '+ Vowel' })
            .addEventListener('click', () => {
                this.phon.vowels.push({ symbol: '', pron: '', long: false });
                savePhon(); redrawVowels();
            });

        el.createEl('div', { cls: 'rw-divider' });

        // ── Consonants ────────────────────────────────────────────────────────
        const conSection = el.createEl('div', { cls: 'rw-phon-section' });
        conSection.createEl('p', { cls: 'rw-label', text: 'Consonants' });
        const conList = conSection.createEl('div', { cls: 'rw-phon-list' });

        const redrawConsonants = () => {
            conList.empty();
            this.phon.consonants.forEach((ph, i) =>
                renderPhonRow(conList, ph, false,
                    savePhon,
                    () => { this.phon.consonants.splice(i, 1); savePhon(); redrawConsonants(); }
                )
            );
        };
        redrawConsonants();
        conSection.createEl('button', { cls: 'rw-btn rw-btn-sm', text: '+ Consonant' })
            .addEventListener('click', () => {
                this.phon.consonants.push({ symbol: '', pron: '', long: false });
                savePhon(); redrawConsonants();
            });

        el.createEl('div', { cls: 'rw-divider' });

        // ── Validation mode ───────────────────────────────────────────────────
        const modeSection = el.createEl('div', { cls: 'rw-phon-section' });
        modeSection.createEl('p', { cls: 'rw-label', text: 'Validation mode' });
        const modeRow = modeSection.createEl('div', { cls: 'rw-mode-row' });
        const makeMode = (id: 'strict' | 'permissive', label: string, desc: string) => {
            const btn = modeRow.createEl('button', {
                cls: 'rw-mode-btn' + (this.phon.mode === id ? ' is-active' : ''),
                text: label,
            });
            btn.title = desc;
            btn.addEventListener('click', () => {
                this.phon.mode = id;
                savePhon();
                modeRow.querySelectorAll('.rw-mode-btn').forEach(b => b.removeClass('is-active'));
                btn.addClass('is-active');
            });
        };
        makeMode('strict',     'Strict',     'Warn if a word uses sounds not in your inventory.');
        makeMode('permissive', 'Permissive', 'Allow any characters; inventory is for reference only.');

        const bannedWrap = modeSection.createEl('div', { cls: 'rw-modal-field' });
        bannedWrap.createEl('label', { text: 'Banned clusters (comma-separated):' });
        const bannedIn = bannedWrap.createEl('input', { cls: 'rw-input', attr: { type: 'text', value: this.phon.banned.join(', '), placeholder: 'e.g. kk, str' } });
        bannedIn.addEventListener('change', () => {
            this.phon.banned = bannedIn.value.split(',').map(s => s.trim()).filter(Boolean);
            savePhon();
        });

        el.createEl('div', { cls: 'rw-divider' });

        // ── Try a word ────────────────────────────────────────────────────────
        const trySection = el.createEl('div', { cls: 'rw-phon-section' });
        trySection.createEl('p', { cls: 'rw-label', text: 'Try a word' });
        trySection.createEl('p', { cls: 'rw-subtitle', text: 'See how a word breaks into phonemes and syllables. Click a syllable to correct the stress — the network learns each time.' });

        const tryInput  = trySection.createEl('input', { cls: 'rw-input rw-input-lg', attr: { type: 'text', placeholder: 'Type a word…' } });
        const tryResult = trySection.createEl('div',   { cls: 'rw-phon-try-result' });

        const tryWord = (forcedStress?: number) => {
            tryResult.empty();
            const w = tryInput.value.trim().toLowerCase();
            if (!w) return;

            const allPh    = [...this.phon.vowels, ...this.phon.consonants];
            const vowelSet = new Set(this.phon.vowels.map(v => v.symbol));
            const tokens   = phonTokenize(w, allPh);
            const syllTokens = phonSyllabify(tokens, vowelSet);
            const sylls      = makeSyllables(syllTokens, this.phon);
            const knownSet   = new Set(allPh.map(p => p.symbol));
            const unknown    = tokens.filter(p => !knownSet.has(p));

            if (!tokens.length) return;

            // Syllable breakdown display
            const breakRow = tryResult.createEl('div', { cls: 'rw-phon-break' });
            syllTokens.forEach((syll, si) => {
                if (si > 0) breakRow.createEl('span', { cls: 'rw-phon-dot', text: ' · ' });
                syll.forEach(p => {
                    const ph = allPh.find(x => x.symbol === p);
                    const sp = breakRow.createEl('span', { cls: ph ? 'rw-phon-token' : 'rw-phon-unknown', text: p });
                    if (ph) sp.title = ph.pron;
                });
            });

            if (sylls.length === 0) return;

            if (!this.plugin.phonModel && allPh.length > 0)
                this.plugin.phonModel = newPhonModel(allPh.map(p => p.symbol));
            const model = this.plugin.phonModel;

            // wordStress is the authoritative override table — O(1) lookup, no array scan
            const storedStress: number | undefined = this.plugin.wordStress[w];

            // Shared correction handler
            const submitCorrection = (stressIdx: number) => {
                // Update the simple override table immediately
                this.plugin.wordStress[w] = stressIdx;
                // Also keep phonExamples in sync for NN training
                const ex: PronEx = { word: w, sylls: syllTokens, stress: stressIdx };
                const prev = this.plugin.phonExamples.findIndex(e => e.word === w);
                if (prev >= 0) this.plugin.phonExamples[prev] = ex;
                else this.plugin.phonExamples.push(ex);
                const m = this.plugin.phonModel ?? newPhonModel(allPh.map(p => p.symbol));
                this.plugin.phonModel = m;
                for (let ep = 0; ep < 20; ep++) trainOnExample(ex, m, this.phon, 0.02);
                if (this.plugin.phonExamples.length <= 40)
                    batchTrain(this.plugin.phonExamples, m, this.phon, 10);
                void this.plugin.saveSettings();
                new Notice('Correction saved!');
                tryWord(stressIdx);
            };

            // forcedStress (from submitCorrection) > wordStress override > NN prediction
            const activeStress = forcedStress !== undefined
                ? forcedStress
                : (storedStress !== undefined
                    ? storedStress
                    : (model && this.plugin.phonExamples.length >= 2
                        ? predictStress(sylls, model).stressIdx
                        : null));
            const isOverride = forcedStress !== undefined || storedStress !== undefined;

            if (activeStress !== null && sylls.length > 0) {
                const pron    = phonReconstruct(syllTokens, activeStress);
                const reading = phonPronReading(syllTokens, activeStress, this.phon);
                const pronRow = tryResult.createEl('div', { cls: 'rw-phon-pron-row' });
                renderSyllableDisplay(pronRow, syllTokens, activeStress);
                pronRow.createEl('span', { cls: 'rw-phon-reading', text: reading });

                if (isOverride) {
                    pronRow.createEl('span', { cls: 'rw-conf rw-conf-high', text: '✓ corrected' });
                } else if (model) {
                    const { confidence } = predictStress(sylls, model);
                    const confPct = Math.round(confidence * 100);
                    const confCls = confidence > 0.75 ? 'rw-conf-high' : confidence > 0.45 ? 'rw-conf-mid' : 'rw-conf-low';
                    pronRow.createEl('span', { cls: `rw-conf ${confCls}`, text: `${confPct}% confident` });
                }

                if (sylls.length > 1) {
                    const corrRow = tryResult.createEl('div', { cls: 'rw-phon-corr-row' });
                    corrRow.createEl('span', { cls: 'rw-label', text: isOverride ? 'Change: ' : 'Correct: ' });
                    const corrIn = corrRow.createEl('input', {
                        cls: 'rw-input rw-phon-corr-input',
                        attr: { type: 'text', value: pron, placeholder: `'syll-syll  (apostrophe = stress)` },
                    });
                    const applyCorr = () => {
                        const si = parseStressNotation(corrIn.value, sylls.length);
                        if (si === null) { new Notice(`Put ' before the stressed syllable, e.g. '${syllTokens[0].join('')}-${syllTokens[1]?.join('') ?? ''}`); return; }
                        submitCorrection(si);
                    };
                    corrIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyCorr(); });
                    corrRow.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Submit' })
                        .addEventListener('click', applyCorr);

                    const stressRow = tryResult.createEl('div', { cls: 'rw-phon-stress-row' });
                    stressRow.createEl('span', { cls: 'rw-label', text: 'or click: ' });
                    syllTokens.forEach((syll, si) => {
                        stressRow.createEl('button', {
                            cls: 'rw-btn rw-btn-sm rw-phon-syll' + (si === activeStress ? ' is-stressed' : ''),
                            text: syll.join(''),
                        }).addEventListener('click', () => submitCorrection(si));
                    });
                } else {
                    tryResult.createEl('p', { cls: 'rw-phon-hint', text: 'Single syllable — no stress to predict.' });
                }
            } else if (sylls.length > 1) {
                const needed = Math.max(0, 2 - this.plugin.phonExamples.length);
                tryResult.createEl('p', { cls: 'rw-empty', text: `${needed} more example${needed !== 1 ? 's' : ''} needed to enable predictions.` });

                const corrRow = tryResult.createEl('div', { cls: 'rw-phon-corr-row' });
                corrRow.createEl('span', { cls: 'rw-label', text: 'Type stress: ' });
                const corrIn = corrRow.createEl('input', {
                    cls: 'rw-input rw-phon-corr-input',
                    attr: { type: 'text', placeholder: `'syll-syll  (apostrophe = stress)` },
                });
                const applyCorr = () => {
                    const si = parseStressNotation(corrIn.value, sylls.length);
                    if (si === null) { new Notice(`Put ' before the stressed syllable, e.g. '${syllTokens[0].join('')}-${syllTokens[1]?.join('') ?? ''}`); return; }
                    submitCorrection(si);
                };
                corrIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyCorr(); });
                corrRow.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Submit' })
                    .addEventListener('click', applyCorr);

                const stressRow = tryResult.createEl('div', { cls: 'rw-phon-stress-row' });
                stressRow.createEl('span', { cls: 'rw-label', text: 'or click: ' });
                syllTokens.forEach((syll, si) => {
                    stressRow.createEl('button', {
                        cls: 'rw-btn rw-btn-sm rw-phon-syll',
                        text: syll.join(''),
                    }).addEventListener('click', () => submitCorrection(si));
                });
            }

            if (this.phon.mode === 'strict' && unknown.length > 0)
                tryResult.createEl('p', { cls: 'rw-phon-warn', text: `Unknown sounds: ${[...new Set(unknown)].join(', ')} — add them to your inventory above.` });

            // Banned cluster check
            const wordStr = tokens.join('');
            const hits    = this.phon.banned.filter(b => b && wordStr.includes(b));
            if (hits.length)
                tryResult.createEl('p', { cls: 'rw-phon-warn', text: `Banned cluster${hits.length > 1 ? 's' : ''}: ${hits.join(', ')}` });
        };

        tryInput.addEventListener('input', () => tryWord());

        el.createEl('div', { cls: 'rw-divider' });

        // ── Phoneme map ───────────────────────────────────────────────────────
        const mapSection = el.createEl('div', { cls: 'rw-phon-section' });
        mapSection.createEl('p', { cls: 'rw-label', text: 'Phoneme map' });

        const model = this.plugin.phonModel;
        if (model && this.plugin.phonExamples.length >= 5) {
            mapSection.createEl('p', { cls: 'rw-subtitle', text: 'Phonemes that behave similarly in stress patterns cluster together. Circle = vowel, diamond = consonant.' });
            const allPh    = [...this.phon.vowels, ...this.phon.consonants];
            const vowelSet = new Set(this.phon.vowels.map(v => v.symbol));
            const withEmb  = allPh.filter(ph => model.E[ph.symbol]);

            if (withEmb.length >= 3) {
                const vecs   = withEmb.map(ph => model.E[ph.symbol]);
                const coords = pca2d(vecs);
                const xs = coords.map(c => c[0]), ys = coords.map(c => c[1]);
                const minX = Math.min(...xs), maxX = Math.max(...xs);
                const minY = Math.min(...ys), maxY = Math.max(...ys);
                const rX = maxX - minX || 1, rY = maxY - minY || 1;
                const mapX = (x: number) => 20 + ((x - minX) / rX) * 180;
                const mapY = (y: number) => 20 + ((y - minY) / rY) * 150;

                const svgEl = activeDocument.createElementNS(SVGNS, 'svg');
                svgEl.setAttribute('width', '220'); svgEl.setAttribute('height', '200');
                svgEl.setAttribute('class', 'rw-phon-map');

                withEmb.forEach((ph, i) => {
                    const x = mapX(coords[i][0]), y = mapY(coords[i][1]);
                    const isV = vowelSet.has(ph.symbol);
                    if (isV) {
                        const c = activeDocument.createElementNS(SVGNS, 'circle');
                        c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
                        c.setAttribute('r', '6'); c.setAttribute('class', 'rw-node-root');
                        svgEl.appendChild(c);
                    } else {
                        const r = activeDocument.createElementNS(SVGNS, 'rect');
                        r.setAttribute('x', String(x - 5)); r.setAttribute('y', String(y - 5));
                        r.setAttribute('width', '10'); r.setAttribute('height', '10');
                        r.setAttribute('transform', `rotate(45,${x},${y})`);
                        r.setAttribute('class', 'rw-node-word');
                        svgEl.appendChild(r);
                    }
                    const t = activeDocument.createElementNS(SVGNS, 'text');
                    t.setAttribute('x', String(x)); t.setAttribute('y', String(y - 10));
                    t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'rw-graph-label');
                    t.textContent = `${ph.symbol} (${ph.pron})`;
                    svgEl.appendChild(t);
                });
                mapSection.appendChild(svgEl);
            } else {
                mapSection.createEl('p', { cls: 'rw-empty', text: 'Not enough phonemes with trained embeddings yet.' });
            }
        } else {
            const needed = Math.max(0, 5 - this.plugin.phonExamples.length);
            mapSection.createEl('p', { cls: 'rw-empty', text: `Map appears after ${needed} more stress example${needed !== 1 ? 's' : ''}. Use "Try a word" to add them.` });
        }

        el.createEl('div', { cls: 'rw-divider' });

        // ── Notes ─────────────────────────────────────────────────────────────
        const notesSection = el.createEl('div', { cls: 'rw-phon-section' });
        notesSection.createEl('p', { cls: 'rw-label', text: 'Notes' });
        const notesArea = notesSection.createEl('textarea', { cls: 'rw-textarea', attr: { placeholder: 'Free-form phonology notes…', rows: '3' } });
        notesArea.value = this.phon.notes;
        notesArea.addEventListener('change', () => { this.phon.notes = notesArea.value; savePhon(); });

        // ── Observations ──────────────────────────────────────────────────────
        const obs = inferPhono(this.words, this.phon);
        if (obs.length) {
            el.createEl('div', { cls: 'rw-divider' });
            const obsSection = el.createEl('div', { cls: 'rw-phon-section' });
            obsSection.createEl('p', { cls: 'rw-label', text: 'Phonotactics observations' });
            obsSection.createEl('p', { cls: 'rw-subtitle', text: 'Automatically inferred from your word list.' });
            const obsList = obsSection.createEl('ul', { cls: 'rw-obs-list' });
            obs.forEach(o => obsList.createEl('li', { text: o }));
        }

        // ── Training info ─────────────────────────────────────────────────────
        if (this.plugin.phonExamples.length > 0) {
            el.createEl('div', { cls: 'rw-divider' });
            const trainSection = el.createEl('div', { cls: 'rw-phon-section' });
            trainSection.createEl('p', { cls: 'rw-label', text: 'Training data' });
            trainSection.createEl('p', { cls: 'rw-subtitle', text: `${this.plugin.phonExamples.length} stress example${this.plugin.phonExamples.length !== 1 ? 's' : ''} saved.` });

            const runTrainBtn = trainSection.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Re-train (50 epochs)' });
            runTrainBtn.addEventListener('click', () => {
                if (!this.plugin.phonModel) {
                    const allPh = [...this.phon.vowels, ...this.phon.consonants];
                    this.plugin.phonModel = newPhonModel(allPh.map(p => p.symbol));
                }
                const m = this.plugin.phonModel ?? newPhonModel([...this.phon.vowels, ...this.phon.consonants].map(p => p.symbol));
                this.plugin.phonModel = m;
                batchTrain(this.plugin.phonExamples, m, this.phon, 50);
                void this.plugin.saveSettings();
                new Notice('Re-training complete!');
            });

            const clearBtn = trainSection.createEl('button', { cls: 'rw-btn rw-btn-sm rw-btn-danger rw-btn-ml', text: 'Clear training data' });
            clearBtn.addEventListener('click', () => {
                this.plugin.phonExamples = [];
                this.plugin.phonModel    = null;
                this.plugin.wordStress   = {};
                void this.plugin.saveSettings();
                new Notice('Training data cleared.');
                this.render();
            });
        }
    }
}

// ─── Graph View ───────────────────────────────────────────────────────────────

class GraphView extends ItemView {
    plugin: RootweavePlugin;
    private roots: Root[] = [];
    private words: Word[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: RootweavePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType()    { return VIEW_TYPE_GRAPH; }
    getDisplayText() { return 'Root Graph'; }
    getIcon()        { return 'git-fork'; }

    async onOpen() {
        try {
            [this.roots, this.words] = await Promise.all([
                this.plugin.loadRoots(),
                this.plugin.loadWords(),
            ]);
        } catch (e) { console.error('Rootweave graph error', e); }
        this.render();
    }

    async onClose(): Promise<void> {}

    private render() {
        const el = this.contentEl;
        el.empty();
        el.addClass('rw-graph-view');

        // Toolbar
        const bar = el.createEl('div', { cls: 'rw-graph-bar' });
        const legend = bar.createEl('span', { cls: 'rw-graph-legend' });
        legend.createEl('span', { cls: 'rw-legend-root', text: '●' });
        legend.appendText(' Root   ');
        legend.createEl('span', { cls: 'rw-legend-word', text: '●' });
        legend.appendText(' Word');
        bar.createEl('button', { cls: 'rw-btn rw-btn-sm', text: 'Refresh' })
            .addEventListener('click', () => { void this.onOpen(); });

        if (!this.roots.length && !this.words.length) {
            el.createEl('p', { cls: 'rw-empty', text: 'No data yet — add some roots and words first.' });
            return;
        }

        const canvas = el.createEl('div', { cls: 'rw-graph-canvas' });
        // Wait one frame so the container has layout dimensions before we measure it
        window.requestAnimationFrame(() => { this.buildGraph(canvas); });
    }

    private buildGraph(container: HTMLElement) {
        const W = container.clientWidth  || 500;
        const H = container.clientHeight || 500;

        // Build node and edge lists from plugin data
        const nodes: GNode[] = [
            ...this.roots.map(r => ({ id: `r:${r.root}`, kind: 'root' as const, label: r.root, sub: r.meaning, tag: r.category, x: 0, y: 0, vx: 0, vy: 0 })),
            ...this.words.map(w => ({ id: `w:${w.word}`, kind: 'word' as const, label: w.word, sub: w.meaning, tag: w.pos,      x: 0, y: 0, vx: 0, vy: 0 })),
        ];
        const edges: GEdge[] = this.words.flatMap(w =>
            w.roots
                .filter(r => nodes.some(n => n.id === `r:${r}`))
                .map(r => ({ src: `r:${r}`, tgt: `w:${w.word}` }))
        );

        forceLayout(nodes, edges, W, H);

        const nodeMap = new Map(nodes.map(n => [n.id, n]));

        // SVG root
        const svg = mksvg('svg') as SVGSVGElement;
        svg.setAttribute('width',  String(W));
        svg.setAttribute('height', String(H));
        container.appendChild(svg);

        // One group we transform for pan/zoom
        let panX = 0, panY = 0, zoom = 1;
        const world = mksvg('g') as SVGGElement;
        svg.appendChild(world);

        const applyTransform = () =>
            world.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
        applyTransform();

        // Convert screen coords to graph coords
        const toGraph = (ex: number, ey: number) => {
            const r = svg.getBoundingClientRect();
            return { x: (ex - r.left - panX) / zoom, y: (ey - r.top - panY) / zoom };
        };

        // ── Edges ──────────────────────────────────────────────────────────────

        const edgeEls = new Map<string, SVGLineElement>();
        edges.forEach(e => {
            const src = nodeMap.get(e.src), tgt = nodeMap.get(e.tgt);
            if (!src || !tgt) return;
            const line = mksvg('line') as SVGLineElement;
            line.setAttribute('class', 'rw-graph-edge');
            line.setAttribute('x1', String(src.x)); line.setAttribute('y1', String(src.y));
            line.setAttribute('x2', String(tgt.x)); line.setAttribute('y2', String(tgt.y));
            world.appendChild(line);
            edgeEls.set(`${e.src}|${e.tgt}`, line);
        });

        const refreshEdges = () => edges.forEach(e => {
            const line = edgeEls.get(`${e.src}|${e.tgt}`);
            const src  = nodeMap.get(e.src), tgt = nodeMap.get(e.tgt);
            if (!line || !src || !tgt) return;
            line.setAttribute('x1', String(src.x)); line.setAttribute('y1', String(src.y));
            line.setAttribute('x2', String(tgt.x)); line.setAttribute('y2', String(tgt.y));
        });

        // ── Nodes ──────────────────────────────────────────────────────────────

        const nodeEls = new Map<string, SVGGElement>();
        const tip = container.createEl('div', { cls: 'rw-graph-tip' });

        nodes.forEach(node => {
            const g = mksvg('g') as SVGGElement;
            g.setAttribute('class', `rw-graph-node rw-graph-node-${node.kind}`);
            g.setAttribute('transform', `translate(${node.x},${node.y})`);

            const radius = node.kind === 'root' ? 13 : 8;
            const circle = mksvg('circle') as SVGCircleElement;
            circle.setAttribute('r', String(radius));
            circle.setAttribute('class', `rw-node-${node.kind}`);
            g.appendChild(circle);

            const label = mksvg('text') as SVGTextElement;
            label.setAttribute('y', String(radius + 12));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'rw-graph-label');
            label.textContent = node.label;
            g.appendChild(label);

            world.appendChild(g);
            nodeEls.set(node.id, g);

            g.addEventListener('mouseenter', () => {
                tip.setText(`${node.label}  —  ${node.sub}${node.tag ? `  [${node.tag}]` : ''}`);
                tip.addClass('is-visible');
            });
            g.addEventListener('mouseleave', () => tip.removeClass('is-visible'));
        });

        // ── Pointer interaction (drag nodes, pan background, zoom) ─────────────

        let dragNode: GNode | null = null;
        let dragOX = 0, dragOY = 0;
        let panning = false, panSX = 0, panSY = 0;

        nodes.forEach(node => {
            nodeEls.get(node.id)?.addEventListener('mousedown', e => {
                e.stopPropagation();
                const gp = toGraph(e.clientX, e.clientY);
                dragOX = gp.x - node.x;
                dragOY = gp.y - node.y;
                dragNode = node;
            });
        });

        svg.addEventListener('mousedown', e => {
            panning = true;
            panSX = e.clientX - panX;
            panSY = e.clientY - panY;
        });

        svg.addEventListener('mousemove', e => {
            if (dragNode) {
                const gp = toGraph(e.clientX, e.clientY);
                dragNode.x = gp.x - dragOX;
                dragNode.y = gp.y - dragOY;
                nodeEls.get(dragNode.id)?.setAttribute('transform', `translate(${dragNode.x},${dragNode.y})`);
                refreshEdges();
            } else if (panning) {
                panX = e.clientX - panSX;
                panY = e.clientY - panSY;
                applyTransform();
            }
        });

        const stopAll = () => { dragNode = null; panning = false; };
        svg.addEventListener('mouseup',    stopAll);
        svg.addEventListener('mouseleave', stopAll);

        svg.addEventListener('wheel', e => {
            e.preventDefault();
            zoom = Math.max(0.15, Math.min(6, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
            applyTransform();
        }, { passive: false });
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

        // ── Cleanse ────────────────────────────────────────────────────────────
        new Setting(containerEl).setName('Data tools').setHeading();

        new Setting(containerEl)
            .setName('Cleanse special characters')
            .setDesc('Replace accented and non-ASCII letters in all roots and words with plain equivalents (e.g. Ñ→N, é→e, ü→u, æ→ae). Edits your files — make a backup first.')
            .addButton(btn => btn
                .setButtonText('Cleanse')
                .setClass('mod-warning')
                .onClick(() => {
                    void Promise.all([
                        this.plugin.loadRoots(),
                        this.plugin.loadWords(),
                    ]).then(([roots, words]) => {
                        const cleanRoots = roots.map(r => ({
                            ...r,
                            root:       stripDiacritics(r.root),
                            alternates: r.alternates.map((a: string) => stripDiacritics(a)),
                        }));
                        const cleanWords = words.map(w => ({
                            ...w,
                            word: stripDiacritics(w.word),
                        }));
                        void Promise.all([
                            this.plugin.saveRoots(cleanRoots),
                            this.plugin.saveWords(cleanWords),
                        ]).then(() => {
                            new Notice(`Cleansed ${roots.length} roots and ${words.length} words.`);
                            void this.plugin.reloadView();
                        });
                    });
                })
            );
    }
}
