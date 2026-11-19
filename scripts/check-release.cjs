// Run after building: verify the version and every packaged entry point.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Extension version must have three numeric parts');
for (const [label, version] of [
    ['source manifest', readJson('manifest.json').version],
    ['built manifest', readJson('dist/manifest.json').version],
    ['lockfile', readJson('package-lock.json').version],
    ['lockfile root package', readJson('package-lock.json').packages[''].version]
]) assert.equal(version, pkg.version, `${label} version does not match package.json`);
if (process.env.GITHUB_REF_TYPE === 'tag')
    assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'Release tag does not match the extension version');
const notesPath = path.join(root, 'release_notes.md');
// Notes and tests stay local; a clean GitHub checkout does not include them.
if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf8');
    const headingVersion = notes.split(/\r?\n/, 1)[0].match(/^# COR3 Helper (\d+\.\d+\.\d+)(?:[ \t].*)?$/)?.[1];
    assert.equal(headingVersion, pkg.version,
        'Release notes heading does not match the extension version');
}
const manifest = readJson('dist/manifest.json');
const resources = [manifest.background.service_worker, manifest.action.default_popup,
    manifest.side_panel.default_path, manifest.devtools_page, ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(script => script.js),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources)];
function requireAsset(file) {
    const full = path.resolve(root, 'dist', file);
    assert.ok(full.startsWith(path.join(root, 'dist') + path.sep), `Asset escapes dist: ${file}`);
    assert.ok(fs.existsSync(full), `Missing packaged asset: ${file}`);
}
resources.forEach(requireAsset);
let scripts = 0;
for (const entry of fs.readdirSync(path.join(root, 'dist'))) {
    const full = path.join(root, 'dist', entry);
    if (entry.endsWith('.js')) {
        new vm.Script(fs.readFileSync(full, 'utf8'), { filename: entry });
        scripts++;
    }
    if (entry.endsWith('.html')) {
        const html = fs.readFileSync(full, 'utf8');
        for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
            if (!/^(?:https?:|data:|chrome:|\/\/)/.test(match[1])) requireAsset(match[1].split('?')[0]);
        }
    }
}
console.log(`Release ${pkg.version} verified: metadata, tag, packaged assets, and ${scripts} JavaScript files.`);
