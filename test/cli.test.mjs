import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mischief.mjs');

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
    assert.ok(fs.existsSync(path.join(dir, 'mischief.config.mjs')));
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('reports/'));
    const again = run(['init'], { cwd: dir });
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scaffold asserts only routes every app has', async () => {
  // It used to ship routes: ['/', { path: '/pricing' }], so the first run after
  // `init` manufactured a finding for a route the user's app does not serve.
  const pkgRoot = path.resolve(path.dirname(CLI), '..');
  const src = fs.readFileSync(path.join(pkgRoot, 'templates', 'mischief.config.mjs'), 'utf8');
  const live = src.split('\n').filter((l) => !l.trim().startsWith('//'));
  for (const invented of ['/pricing', '/dashboard', '/items', '/sota-arena', '/papers']) {
    assert.ok(!live.join('\n').includes(invented), `the scaffold must not assert ${invented} exists`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-scaffold-'));
  try {
    const p = path.join(dir, 'c.mjs');
    fs.writeFileSync(p, src.replace("'mischief'", JSON.stringify(path.join(pkgRoot, 'src', 'index.mjs'))));
    const { default: cfg } = await import(p);
    assert.deepEqual(cfg.routes, ['/'], "only '/' is universally safe to assert");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no origin-app residue and no invented routes survive outside examples/', () => {
  // A 4-file, 3-token guard is exactly how '/pricing' survived in README.md and
  // 'HypePaper' survived in CHANGELOG.md: neither file was covered for the token
  // that mattered. This sweeps every file the package actually SHIPS.
  const pkgRoot = path.resolve(path.dirname(CLI), '..');
  const skip = new Set(['hypepaper.config.mjs']); // legitimately app-specific, by name
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
      return skip.has(e.name) || !/\.(mjs|js|md|json)$/.test(e.name) ? [] : [p];
    });
  const files = [
    ...['bin', 'src', 'templates', 'test'].flatMap((d) => walk(path.join(pkgRoot, d))),
    ...['README.md', 'CHANGELOG.md', 'package.json'].map((f) => path.join(pkgRoot, f)),
  ];
  assert.ok(files.length > 20, 'the sweep must actually find the package');

  const residue = ['sota-arena', 'hypepaper', 'HypePaper', 'ruckus'];
  const invented = ['/pricing', '/dashboard', '/items', '/papers', '/arena'];
  for (const f of files) {
    const rel = path.relative(pkgRoot, f);
    const src = fs.readFileSync(f, 'utf8');
    // cli.test.mjs itself names the tokens it is guarding against, and the
    // example-config test names the example by path.
    if (rel === 'test/cli.test.mjs') continue;
    for (const r of residue) {
      assert.ok(!src.includes(r), `${rel} still names ${r} — app-specific residue is a defect here`);
    }
    for (const i of invented) {
      assert.ok(!src.includes(i), `${rel} asserts the route ${i}, which the reader's app may not serve`);
    }
  }
});

test('a scaffolded project refuses a hostname outside allowedHosts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-guard-'));
  try {
    run(['init'], { cwd: dir });
    // Make the template's bare import resolve without a real npm install.
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(CLI), '..'), path.join(dir, 'node_modules', 'mischief'), 'dir');
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
      path.join(dir, 'mischief.config.mjs'),
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
    fs.writeFileSync(p, src.replace("'mischief'", JSON.stringify(path.join(pkgRoot, 'src', 'index.mjs'))));
    const { default: cfg } = await import(p);
    const { resolveConfig } = await import(path.join(pkgRoot, 'src', 'index.mjs'));
    const resolved = resolveConfig(cfg, {}, dir);
    assert.equal(resolved.auth.key, 'hypepaper-auth');
    assert.equal(resolved.routes.length, 11);
    // The example has requiresAuth routes with no waitFor. Locks in
    // warning-not-error: a hard error would refuse to run a valid config.
    assert.ok(resolved.warnings.length > 0);
    assert.ok(resolved.allowedHosts.includes('burningxoul.mooo.com'));
    // No credential may be baked into an example that ships in the package.
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(src), 'example must not embed a JWT');
    assert.ok(!/sk-|service_role|anon_key|supabase\.co/i.test(src), 'example must not embed project secrets');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
