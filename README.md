# Rootweave

An [Obsidian](https://obsidian.md) plugin for conlang (constructed language) worldbuilders.

Manage your roots, build and validate words in real time, maintain a dictionary, and translate sentences — all inside your vault. All data is stored as plain Markdown tables so your notes are readable even without the plugin.

Built for [Hack Club Stardance](https://hackclub.com).

---

## Features

| Tab | What it does |
|-----|-------------|
| **Roots** | Add, search, and filter root morphemes with meanings and categories |
| **Builder** | Type a word to see which roots compose it, with live grammar rule checking |
| **Dictionary** | Searchable table of all finalized words |
| **Translate** | Translate English sentences word-by-word; toggle interlinear gloss view |
| **Export** | Open the source Markdown files directly, or export a consolidated snapshot |

---

## Installing

### From the Community Plugins browser *(once listed)*

1. Open Obsidian → **Settings → Community plugins → Browse**
2. Search for **Rootweave** and install
3. Enable it and click the 📖 icon in the left ribbon

### Manual install (developer mode)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/molive6316github/rootweave/releases/latest)
2. Copy them into `<vault>/.obsidian/plugins/rootweave/`
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**

### From source

```bash
git clone https://github.com/molive6316github/rootweave.git
cd rootweave
npm install
npm run install-plugin   # detects your vault automatically
```

---

## Data files

All data lives in a `.rootweave/` folder as **plain Markdown notes**:

```
<vault>/
└── .rootweave/
    ├── Roots.md       ← root morpheme lexicon
    ├── Dictionary.md  ← finalized word list
    └── Grammar.md     ← grammar rules
```

These render as nice tables in Obsidian's reading view. You can edit them by hand, link to them from other notes, or version-control them with git — with or without the plugin installed.

Example `Roots.md`:

```markdown
# Root Lexicon

| root | meaning        | category | notes        |
| ---- | -------------- | -------- | ------------ |
| vel  | light, clarity | element  |              |
| kar  | fire           | element  | prefix: kar- |
```

---

## Grammar rules

Grammar rules live in `.rootweave/Grammar.md`. Two starter rules are written on first launch:

```markdown
| description                   | pattern     | type      | message                                       |
| ----------------------------- | ----------- | --------- | --------------------------------------------- |
| Words must end in a vowel     | [aeiou]$    | required  | This word does not end in a vowel.            |
| No triple consonants in a row | [^aeiou]{3} | forbidden | Three consecutive consonants are not allowed. |
```

| Column | Meaning |
|--------|---------|
| `pattern` | A JavaScript regular expression |
| `type` | `required` — pattern must match; `forbidden` — pattern must not appear |
| `message` | Shown inline in the Builder tab when violated |

Open `Grammar.md` via **Settings → Rootweave → Open Grammar.md**, or the Export tab's file links.

---

## Development

```bash
npm run dev           # watch mode — rebuilds on save
npm run build         # production build
npm run install-plugin  # build + copy to your vault (first time)
npm run update-plugin   # build + push to all vaults that have it installed
```

---

## Releasing a new version

```bash
node version-bump.mjs 1.1.0        # updates package.json, manifest.json, versions.json

git add package.json manifest.json versions.json
git commit -m "chore: bump to 1.1.0"
git tag -a 1.1.0 -m "1.1.0"
git push --follow-tags
```

The GitHub Actions workflow (`.github/workflows/release.yml`) picks up the tag, builds the plugin, and attaches `main.js`, `manifest.json`, and `styles.css` to a GitHub Release automatically.

---

## Submitting to the Community Plugins marketplace

Follow these steps once to get the plugin listed in Obsidian's built-in browser.

### Before you start

- [ ] The GitHub repo is **public**
- [ ] `manifest.json` has your real name in `author` and your repo URL in `authorUrl`
- [ ] There is at least one GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached
- [ ] The plugin ID (`"rootweave"`) is not already taken — check [community-plugins.json](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json)

### Steps

1. **Fork** [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)

2. **Add an entry** to `community-plugins.json` in your fork:
   ```json
   {
     "id": "rootweave",
     "name": "Rootweave",
     "author": "Max Oliver",
     "description": "A conlang workspace for worldbuilders — manage roots, build words, validate grammar, and translate.",
     "repo": "molive6316github/rootweave"
   }
   ```
   Insert it in **alphabetical order by `id`**.

3. **Open a Pull Request** from your fork to `obsidianmd/obsidian-releases`
   - Title: `Add plugin: Rootweave`
   - The Obsidian team will review the code in your repo before merging

4. **Wait for review** — the team checks that the plugin follows [developer policies](https://docs.obsidian.md/Developer+policies). This usually takes a few weeks.

5. **Once merged**, the plugin appears in Obsidian's Community Plugins browser on the next app update.

### What reviewers check

- No network requests without explicit user action
- No obfuscated or minified source code *in the repo* (build output is fine)
- Uses `app.vault` for all file I/O (not Node's `fs` directly)
- `manifest.json` fields are accurate and the version matches the latest release
- The plugin has a `LICENSE` file

---

## Plugin architecture (for new Obsidian devs)

- **`Plugin`** — entry point; `onload()` runs when enabled
- **`ItemView`** — the sidebar panel; UI is built in `onOpen()` with DOM methods (no framework needed)
- **`Modal`** — popup dialogs (Add Root, Edit Root)
- **`Notice`** — toast notifications
- **`app.vault`** — the only safe way to read/write files (works on desktop and mobile)
- **CSS variables** — styles use `var(--text-accent)` etc. so they automatically match any installed theme

---

## License

MIT
