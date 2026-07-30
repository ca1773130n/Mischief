import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'webapp-qa.mjs');

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('--help exits 0 and documents the exit codes', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /0 clean · 1 HIGH · 2 CRITICAL · 3 harness or verification failure/);
});

test('an unknown flag exits 3 rather than running something unintended', () => {
  const r = run(['--wat']);
  assert.equal(r.code, 3);
  assert.match(r.out, /Unknown flag: --wat/);
});

test('init scaffolds a config and a reports/ ignore, and refuses to clobber', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-init-'));
  try {
    const r = run(['init'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'webapp-qa.config.mjs')));
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('reports/'));
    const again = run(['init'], { cwd: dir });
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scaffolded project refuses a hostname outside allowedHosts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-guard-'));
  try {
    run(['init'], { cwd: dir });
    // Make the template's bare import resolve without a real npm install.
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(CLI), '..'), path.join(dir, 'node_modules', 'webapp-qa-kit'), 'dir');
    const r = run(['--base', 'https://app.example.com', '--steps', '1'], { cwd: dir });
    assert.equal(r.code, 3);
    assert.match(r.out, /REFUSED: "app\.example\.com" is not in allowedHosts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--routes FILTERS the config list and keeps each route\'s metadata', () => {
  // Regression: --routes used to replace the route objects with bare strings,
  // which silently dropped requiresAuth and waitFor — disabling the very
  // verification that makes a gated route's result trustworthy.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-routes-'));
  try {
    const pkgRoot = path.resolve(path.dirname(CLI), '..');
    fs.writeFileSync(
      path.join(dir, 'webapp-qa.config.mjs'),
      `import { defineConfig } from ${JSON.stringify(path.join(pkgRoot, 'src', 'index.mjs'))};\n` +
        `export default defineConfig({\n` +
        `  baseUrl: 'http://localhost:1',\n` +
        `  routes: ['/', { path: '/dash', requiresAuth: true }],\n` +
        `});\n`,
    );
    // No auth is configured, so keeping requiresAuth means the pre-flight guard
    // must fire and name /dash. If the metadata were dropped, the run would
    // proceed and open a browser.
    const r = run(['--routes', '/dash', '--steps', '1'], { cwd: dir });
    assert.equal(r.code, 3);
    assert.match(r.out, /1 of 1 routes declare requiresAuth/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped HypePaper example is a valid config', async () => {
  // Guards against the example rotting into something that would not load.
  const pkgRoot = path.resolve(path.dirname(CLI), '..');
  const src = fs.readFileSync(path.join(pkgRoot, 'examples', 'hypepaper.config.mjs'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-example-'));
  try {
    const p = path.join(dir, 'ex.mjs');
    fs.writeFileSync(p, src.replace("'webapp-qa-kit'", JSON.stringify(path.join(pkgRoot, 'src', 'index.mjs'))));
    const { default: cfg } = await import(p);
    const { resolveConfig } = await import(path.join(pkgRoot, 'src', 'index.mjs'));
    const resolved = resolveConfig(cfg, {}, dir);
    assert.equal(resolved.auth.key, 'hypepaper-auth');
    assert.equal(resolved.routes.length, 11);
    assert.ok(resolved.allowedHosts.includes('burningxoul.mooo.com'));
    // No credential may be baked into an example that ships in the package.
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(src), 'example must not embed a JWT');
    assert.ok(!/sk-|service_role|anon_key|supabase\.co/i.test(src), 'example must not embed project secrets');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
