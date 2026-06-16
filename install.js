#!/usr/bin/env node
/**
 * install.js — one-command installer for the Rootweave Obsidian plugin
 *
 * Run it with:
 *   npm run install-plugin              ← auto-detects your vault(s)
 *   npm run install-plugin "C:/path/to/vault"  ← target a specific vault
 *
 * What it does:
 *   1. Builds main.ts → main.js  (via esbuild)
 *   2. Reads Obsidian's own config to find your vault(s)
 *   3. Copies main.js + manifest.json + styles.css into
 *      <vault>/.obsidian/plugins/rootweave/
 *   4. Tells you what to click in Obsidian to finish
 */

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const readline  = require('readline');
const { execSync } = require('child_process');

// The three files Obsidian requires to load a plugin
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];
const PLUGIN_ID    = 'rootweave';

// ── 1. Build ──────────────────────────────────────────────────────────────────

function build() {
    console.log('\n📦  Building plugin…');
    try {
        execSync('node esbuild.config.mjs production', { stdio: 'inherit' });
    } catch {
        console.error('\n❌  Build failed. Make sure you ran `npm install` first.');
        process.exit(1);
    }
    console.log('✅  Build done.\n');
}

// ── 2. Find vaults ────────────────────────────────────────────────────────────

/**
 * Obsidian stores a list of every vault you've opened in obsidian.json.
 * The file location differs by OS:
 *   Windows  → %APPDATA%\obsidian\obsidian.json
 *   macOS    → ~/Library/Application Support/obsidian/obsidian.json
 *   Linux    → ~/.config/obsidian/obsidian.json
 */
function findVaults() {
    let configDir;
    if (process.platform === 'win32') {
        configDir = path.join(process.env.APPDATA || '', 'obsidian');
    } else if (process.platform === 'darwin') {
        configDir = path.join(os.homedir(), 'Library', 'Application Support', 'obsidian');
    } else {
        // WSL: Obsidian runs on Windows, so check the Windows AppData path first
        const wslWindowsAppData = '/mnt/c/Users/' + os.userInfo().username + '/AppData/Roaming/obsidian';
        if (process.env.WSL_DISTRO_NAME && fs.existsSync(wslWindowsAppData)) {
            configDir = wslWindowsAppData;
        } else {
            configDir = path.join(os.homedir(), '.config', 'obsidian');
        }
    }

    const configFile = path.join(configDir, 'obsidian.json');
    if (!fs.existsSync(configFile)) return [];

    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        // obsidian.json has a "vaults" object keyed by random IDs.
        // On WSL, Windows paths like "C:\foo" must become "/mnt/c/foo".
        return Object.values(config.vaults || {})
            .map(v => {
                let p = v.path;
                if (p && process.env.WSL_DISTRO_NAME) {
                    p = p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase());
                }
                return p;
            })
            .filter(p => p && fs.existsSync(p));
    } catch {
        return [];
    }
}

// ── 3. Install into a vault ───────────────────────────────────────────────────

function installToVault(vaultPath) {
    const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);

    // mkdir -p equivalent — creates the folder chain if it doesn't exist
    fs.mkdirSync(pluginDir, { recursive: true });

    for (const file of PLUGIN_FILES) {
        const src  = path.join(__dirname, file);
        const dest = path.join(pluginDir, file);

        if (!fs.existsSync(src)) {
            console.error(`❌  Missing: ${file} — did the build succeed?`);
            process.exit(1);
        }

        fs.copyFileSync(src, dest);
        console.log(`   ✓ ${file}`);
    }

    console.log(`\n✅  Installed to:\n   ${pluginDir}`);
    console.log('\n👉  In Obsidian, do ONE of these to activate:');
    console.log('    • Settings → Community Plugins → Rootweave → toggle off then on');
    console.log('    • Or: Ctrl/Cmd+P → "Reload app without saving"\n');
}

// ── 4. Prompt helper ──────────────────────────────────────────────────────────

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🌿  Rootweave Installer');
    console.log('─'.repeat(40));

    // Allow passing a vault path directly: npm run install-plugin "C:/my/vault"
    const argVault = process.argv[2];

    let vaultPath;

    if (argVault) {
        if (!fs.existsSync(argVault)) {
            console.error(`❌  "${argVault}" does not exist.`);
            process.exit(1);
        }
        if (!fs.existsSync(path.join(argVault, '.obsidian'))) {
            console.log(`⚠️   No .obsidian folder found — creating it. Open the vault in Obsidian after installing to finish initialization.`);
        }
        vaultPath = argVault;
    } else {
        const vaults = findVaults();

        if (vaults.length === 0) {
            console.log('⚠️   Could not find any Obsidian vaults automatically.');
            console.log('    Pass your vault path manually:\n');
            console.log('    npm run install-plugin "C:/path/to/your/vault"\n');
            process.exit(1);
        }

        if (vaults.length === 1) {
            vaultPath = vaults[0];
            console.log(`🔍  Found vault: ${vaultPath}`);
        } else {
            console.log('🔍  Found multiple vaults:');
            vaults.forEach((v, i) => console.log(`    [${i + 1}] ${v}`));
            const answer = await ask('\nInstall into which vault? Enter a number: ');
            const idx = parseInt(answer, 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= vaults.length) {
                console.error('❌  Invalid selection.');
                process.exit(1);
            }
            vaultPath = vaults[idx];
        }
    }

    build();

    console.log(`📂  Copying files into vault…`);
    installToVault(vaultPath);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
