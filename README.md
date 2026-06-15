# Rootweave

An [Obsidian](https://obsidian.md) plugin for conlang (constructed language) worldbuilders.

Manage your roots, build and validate words in real time, maintain a dictionary, and translate sentences — all inside your vault.

Built for [Hack Club Stardance](https://hackclub.com).

---

## Features

| Tab | What it does |
|-----|-------------|
| **Roots** | Add, search, and filter root morphemes with meanings and categories |
| **Builder** | Type a word to see which roots compose it and check it against your grammar rules |
| **Dictionary** | Searchable table of all finalized words; delete entries as needed |
| **Translate** | Translate English sentences word-by-word; toggle an interlinear gloss view |
| **Export** | Export your full lexicon and dictionary to a Markdown file in your vault |

---

## Installing

> You need [Node.js](https://nodejs.org) (v16+) and [git](https://git-scm.com) installed.

**Step 1 — Clone into your vault's plugin folder**

```bash
# Replace <your-vault> with the actual path to your vault
cd "<your-vault>/.obsidian/plugins"
git clone https://github.com/yourusername/rootweave.git
cd rootweave
```

**Step 2 — Install dependencies and build**

```bash
npm install
npm run build
```

This creates `main.js`, which is the file Obsidian actually loads.

**Step 3 — Enable in Obsidian**

1. Open Obsidian → **Settings** → **Community plugins**
2. Turn off **Restricted mode** if it's on
3. Find **Rootweave** in the list and toggle it on
4. Click the book icon (🔖) in the left ribbon, or press `Ctrl/Cmd + P` and run **"Open Rootweave Panel"**

---

## Development

```bash
npm run dev   # watch mode — rebuilds on every save
npm run build # production build (no source maps)
```

During development, `npm run dev` watches for changes and rebuilds automatically. You then reload the plugin in Obsidian via **Settings → Community Plugins → Rootweave → Reload**.

---

## Data files

All your conlang data lives in a `.rootweave/` folder as **plain Markdown notes**:

```
<vault>/
└── .rootweave/
    ├── Roots.md       ← root morpheme lexicon
    ├── Dictionary.md  ← finalized word list
    └── Grammar.md     ← grammar rules
```

These are regular Obsidian notes with Markdown tables. You can open, read, and edit them directly — even with the plugin disabled. The plugin is just a convenient UI on top of them.

Example of what `Roots.md` looks like:

```markdown
# Root Lexicon

| root | meaning        | category | notes        |
| ---- | -------------- | -------- | ------------ |
| vel  | light, clarity | element  |              |
| kar  | fire           | element  | prefix: kar- |
```

---

## Grammar rules

Grammar rules live in `.rootweave/Grammar.md` as a Markdown table. Two starter rules are created on first launch:

```markdown
| description                   | pattern     | type     | message                                      |
| ----------------------------- | ----------- | -------- | -------------------------------------------- |
| Words must end in a vowel     | [aeiou]$    | required | This word does not end in a vowel.           |
| No triple consonants in a row | [^aeiou]{3} | forbidden | Three consecutive consonants are not allowed.|
```

**Columns:**

| Column | Value |
|--------|-------|
| `pattern` | A JavaScript regular expression |
| `type` | `required` — pattern must match; `forbidden` — pattern must not appear |
| `message` | Shown in the Builder tab when the rule is violated |

Open `Grammar.md` from **Settings → Rootweave → Open Grammar.md**, or click it in the Export tab.

---

## How Obsidian plugins work (for new plugin devs)

If this is your first Obsidian plugin, here's the 60-second mental model:

- **`Plugin`** — the entry point. `onload()` runs when the plugin is enabled; `onunload()` runs when it's disabled.
- **`ItemView`** — a sidebar panel. You build its UI inside `onOpen()` using DOM methods (no React needed).
- **`Modal`** — a popup dialog. Used for the "Add Root" and "Edit Root" forms.
- **`Notice`** — a toast notification in the corner.
- **Vault API** — `this.app.vault` is the only safe way to read/write files. Never use Node's `fs` directly (it breaks on mobile).

The plugin is written in TypeScript and bundled with [esbuild](https://esbuild.github.io).
Styles use Obsidian's built-in CSS variables so they automatically match any theme.

---

## License

MIT
