#!/usr/bin/env node
/**
 * update.js — push a new build to every vault that already has Rootweave installed
 *
 * Run: npm run update-plugin
 *
 * Unlike install.js (which asks where to install), this script:
 *   1. Finds every Obsidian vault on your machine
 *   2. Filters to only the ones that already have the plugin folder
 *   3. Builds once, then copies the files to all of them automatically
 *
 * No prompts — if it's installed somewhere, it gets updated.
 */

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { execSync } = require('child_process');

const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];
const PLUGIN_ID    = 'rootweave';

// ── Find all Obsidian vaults ──────────────────────────────────────────────────

function findAllVaults() {
    let configDir;
    if (process.platform === 'win32') {
        configDir = path.join(process.env.APPDATA || '', 'obsidian');
    } else if (process.platform === 'darwin') {
        configDir = path.join(os.homedir(), 'Library', 'Application Support', 'obsidian');
    } else {
        configDir = path.join(os.homedir(), '.config', 'obsidian');
    }

    const configFile = path.join(configDir, 'obsidian.json');
    if (!fs.existsSync(configFile)) return [];

    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        return Object.values(config.vaults || {})
            .map(v => v.path)
            .filter(p => p && fs.existsSync(p));
    } catch {
        return [];
    }
}

// ── Only keep vaults where the plugin is already installed ────────────────────

function installedVaults(allVaults) {
    return allVaults.filter(vault =>
        fs.existsSync(path.join(vault, '.obsidian', 'plugins', PLUGIN_ID))
    );
}

// ── Build ─────────────────────────────────────────────────────────────────────

function build() {
    console.log('\n📦  Building…');
    try {
        execSync('node esbuild.config.mjs production', { stdio: 'inherit' });
    } catch {
        console.error('\n❌  Build failed. Run `npm install` if you haven\'t yet.');
        process.exit(1);
    }
    console.log('✅  Build done.\n');
}

// ── Copy files into one vault ─────────────────────────────────────────────────

function copyToVault(vaultPath) {
    const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);
    for (const file of PLUGIN_FILES) {
        const src  = path.join(__dirname, file);
        const dest = path.join(pluginDir, file);
        if (!fs.existsSync(src)) {
            throw new Error(`Missing build output: ${file}`);
        }
        fs.copyFileSync(src, dest);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    console.log('🌿  Rootweave — Update');
    console.log('─'.repeat(40));

    const allVaults    = findAllVaults();
    const targetVaults = installedVaults(allVaults);

    if (allVaults.length === 0) {
        console.log('⚠️   Could not find any Obsidian vaults.');
        console.log('    Make sure Obsidian has been opened at least once.\n');
        process.exit(1);
    }

    if (targetVaults.length === 0) {
        console.log(`⚠️   Rootweave isn't installed in any of your ${allVaults.length} vault(s).`);
        console.log('    Run `npm run install-plugin` first.\n');
        process.exit(1);
    }

    build();

    let ok = 0;
    let failed = 0;

    targetVaults.forEach(vault => {
        try {
            copyToVault(vault);
            console.log(`   ✓ ${vault}`);
            ok++;
        } catch (err) {
            console.error(`   ✗ ${vault}\n     ${err.message}`);
            failed++;
        }
    });

    console.log(`\n✅  Updated ${ok} vault${ok !== 1 ? 's' : ''}.${failed ? ` (${failed} failed)` : ''}`);
    console.log('\n👉  In Obsidian: Ctrl/Cmd+P → "Reload app without saving"');
    console.log('    (or disable + re-enable the plugin in Community Plugins)\n');
}

main();
