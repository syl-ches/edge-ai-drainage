#!/usr/bin/env node
// One-command launcher: `npm start` (or double-click start.bat / ./start.sh).
//
//  1. installs npm packages if node_modules is missing or stale,
//  2. creates .venv and pip-installs requirements.txt on first run (if Python >= 3.10 exists),
//  3. runs the FastAPI backend (:8000) and the Vite frontend (:5173) side by side,
//  4. stops both on Ctrl+C.
//
// Flags: --setup   install everything, then exit
//        --no-backend   frontend only (the app falls back to its built-in storm playback)
//        --prod     serve the production build (vite build + vite preview on :4173)
// No dependencies beyond Node itself.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const SETUP_ONLY = args.has('--setup');
const NO_BACKEND = args.has('--no-backend');
const PROD = args.has('--prod');

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32), yellow = c(33), cyan = c(36), magenta = c(35), bold = c(1), dim = c(2);
const log = (msg) => console.log(`${green('[start]')} ${msg}`);
const warn = (msg) => console.log(`${yellow('[start]')} ${msg}`);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: WIN && cmd === 'npm', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
}

// ------------------------------------------------------------------ Node
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node.js >= 20 is required (found ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

// ------------------------------------------------------------------ npm packages
const stamp = join(ROOT, 'node_modules', '.package-lock.json');
const lock = join(ROOT, 'package-lock.json');
if (!existsSync(stamp) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(stamp).mtimeMs + 1000)) {
  log('Installing npm packages (first run, ~1 min)...');
  run('npm', [existsSync(lock) ? 'ci' : 'install', '--no-audit', '--no-fund']);
}

// ------------------------------------------------------------------ Python backend
function findPython() {
  const candidates = WIN ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0 || !r.stdout) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj === 3 && min >= 10) return [cmd, pre];
  }
  return null;
}

const venvPy = join(ROOT, '.venv', WIN ? 'Scripts/python.exe' : 'bin/python');
let backendPy = null;
if (!NO_BACKEND) {
  if (!existsSync(venvPy)) {
    const py = findPython();
    if (py) {
      log('Creating Python virtual environment (.venv)...');
      try {
        run(py[0], [...py[1], '-m', 'venv', '.venv']);
      } catch (e) {
        warn(`Could not create .venv: ${e.message}`);
      }
    } else {
      warn('Python >= 3.10 not found: starting the frontend only (built-in storm playback).');
      warn('Install Python from https://www.python.org/downloads/ to enable the live backend.');
    }
  }
  if (existsSync(venvPy)) {
    const req = readFileSync(join(ROOT, 'requirements.txt'));
    const hash = createHash('sha1').update(req).digest('hex');
    const depStamp = join(ROOT, '.venv', '.requirements.sha1');
    if (!existsSync(depStamp) || readFileSync(depStamp, 'utf8') !== hash) {
      log('Installing Python packages (first run, ~1 min)...');
      try {
        run(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements.txt']);
        writeFileSync(depStamp, hash);
      } catch (e) {
        warn(`pip install failed (${e.message}); starting the frontend only.`);
      }
    }
    if (existsSync(depStamp)) backendPy = venvPy;
  }
}

if (SETUP_ONLY) {
  log(bold('Setup complete.') + ` Run ${cyan('npm start')} to launch.`);
  process.exit(0);
}

// ------------------------------------------------------------------ launch
const children = [];
function launch(name, color, cmd, cmdArgs, env = {}) {
  const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: { ...process.env, ...env, FORCE_COLOR: '1' } });
  const prefix = color(`[${name}]`.padEnd(10));
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(`${prefix} ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      warn(`${name} exited (code ${code}).`);
      if (name === 'frontend') shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ch of children) {
    if (ch.exitCode !== null) continue;
    if (WIN) spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
    else ch.kill('SIGINT');
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// A port is taken if anything answers on it. (A bind probe is unreliable on Windows, which lets
// a 0.0.0.0 socket coexist with Vite's dual-stack `::` listener.)
const answers = (p, host) =>
  new Promise((res) => {
    const s = connect({ port: p, host, timeout: 400 });
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('timeout', () => (s.destroy(), res(false)));
    s.once('error', () => res(false));
  });
const portFree = async (p) => !(await answers(p, '127.0.0.1')) && !(await answers(p, '::1'));

const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
let port = PROD ? 4173 : 5173;
if (PROD) {
  log('Building production bundle...');
  run('npm', ['run', 'build']);
}
while (!(await portFree(port))) port++;

// The frontend expects the backend on :8000. Reuse a twin backend that is already running there.
let backendNote = dim('  Backend not running: LIVE mode uses the built-in storm playback.');
if (backendPy) {
  if (await portFree(8000)) {
    launch('backend', magenta, backendPy, ['-m', 'uvicorn', 'backend.main:app', '--host', '0.0.0.0', '--port', '8000'], { PYTHONUNBUFFERED: '1' });
    backendNote = `  Live backend API:  ${cyan('http://localhost:8000/docs')}`;
  } else {
    const ok = await fetch('http://127.0.0.1:8000/api/v1/health').then((r) => r.ok, () => false);
    backendNote = ok
      ? `  Live backend already running on :8000, reusing it (${cyan('http://localhost:8000/docs')})`
      : yellow('  Port 8000 is used by another program: LIVE mode falls back to the built-in playback.');
  }
}
launch('frontend', cyan, process.execPath, [vite, ...(PROD ? ['preview'] : []), '--port', String(port), '--strictPort']);

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);
setTimeout(() => {
  console.log('');
  log(bold('City Camp Lagoon digital twin is starting:'));
  log(`  Open in your browser:  ${cyan(`http://localhost:${port}`)}`);
  for (const ip of lan) log(`  On your phone (same Wi-Fi):  ${cyan(`http://${ip}:${port}`)}`);
  log(backendNote);
  log(dim('  Press Ctrl+C to stop.'));
  console.log('');
}, 2500);
