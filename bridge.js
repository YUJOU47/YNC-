#!/usr/bin/env node
/* ============================================================
   TYN Bridge v1.0.1-beta — Project-Aware Fixed Edition
   + ADMIN PANEL (server.html) EMBEDDED  →  GET /admin
   + Default bind 127.0.0.1
   + Localhost bypass untuk state-gate (admin panel bisa bootstrap)
   + Auto-force CWD to project folder (fixes apis.json not found)
   ============================================================ */

'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');

/* ============================================================
   VERSION & PATHS
   ============================================================ */
const VERSION = '1.0.1-beta';
const VERSION_FULL = 'TYN Bridge v' + VERSION;

const ROOT = __dirname;
const APPS_DIR = path.join(ROOT, 'apps');
const CONFIGS_DIR = path.join(ROOT, 'configs');
const LOGS_DIR = path.join(ROOT, 'logs');
const WEBRUN_DIR = path.join(ROOT, 'runtime');
const NANO_DIR = path.join(ROOT, 'nano');
const PROJECT_CWD_DIR = path.join(WEBRUN_DIR, '.project_cwd');
const APIS_FILE = path.join(ROOT, 'apis.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'server.state');
const LEGACY_TOKEN_FILE = path.join(ROOT, '.token');
const INDEX_FILE = 'index.html';
const BASE_PATH = '/index.html';
const WEBRUN_PORT_START = 8080;
const WEBRUN_PORT_END = 8200;
const IDLE_KILL_MS = 60 * 60 * 1000;
const PROGRESS_FLUSH_MS = 500;
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|rb|pl|php|lua|awk)$/i;

[APPS_DIR, CONFIGS_DIR, LOGS_DIR, WEBRUN_DIR, NANO_DIR, PROJECT_CWD_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ============================================================
   STATE / CONFIG / APIS
   ============================================================ */
function loadConfig() {
  // FIX: Default cwd ke ROOT, dan pastikan jika ada config lama yang isinya "~" diganti ROOT
  const defaults = { shell: 'bash', termType: 'xterm-256color', cwd: ROOT, port: 7700, host: '127.0.0.1', webrunPortStart: WEBRUN_PORT_START, webrunPortEnd: WEBRUN_PORT_END };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return defaults;
    const userCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const merged = { ...defaults, ...userCfg };
    if (!merged.cwd || merged.cwd === '~') merged.cwd = ROOT;
    return merged;
  } catch(_) { return defaults; }
}

function getServerState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return 'off';
    return (fs.readFileSync(STATE_FILE, 'utf8').trim() || 'off');
  } catch(_) { return 'off'; }
}

function loadApis() {
  try {
    if (!fs.existsSync(APIS_FILE)) return { apis: [] };
    const d = JSON.parse(fs.readFileSync(APIS_FILE, 'utf8'));
    return Array.isArray(d.apis) ? d : { apis: [] };
  } catch(_) { return { apis: [] }; }
}

function saveApis(data) {
  try { fs.writeFileSync(APIS_FILE, JSON.stringify(data, null, 2)); return true; }
  catch(e) { err('saveApis failed:', e.message); return false; }
}

function validateApiToken(token) {
  if (token === undefined || token === null) return { ok: false, reason: 'missing token' };
  const cleanToken = String(token).trim();
  if (!cleanToken) return { ok: false, reason: 'empty token' };
  const apis = loadApis().apis || [];
  const found = apis.find(a => String(a.token || '').trim() === cleanToken);
  if (!found) return { ok: false, reason: 'token not found', totalTokens: apis.length };
  if (found.revoked) return { ok: false, reason: 'token revoked', api: found };
  if (found.expiresAt && Date.now() > found.expiresAt) {
    return { ok: false, reason: 'token expired', expiredAt: found.expiresAt, api: found };
  }
  const expiresIn = found.expiresAt ? Math.max(0, found.expiresAt - Date.now()) : null;
  return { ok: true, api: found, expiresIn };
}

function getFirstValidToken() {
  const apis = loadApis().apis || [];
  const now = Date.now();
  const v = apis.find(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
  return v ? v.token : '';
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'never';
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function ensureDefaultApi() {
  const data = loadApis();
  const now = Date.now();
  const hasValid = (data.apis || []).some(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
  if (hasValid) return null;
  const token = 'tyn_' + crypto.randomBytes(20).toString('hex');
  data.apis = data.apis || [];
  data.apis.push({ token, label: 'Default (auto-generated)', duration: 'never', createdAt: now, expiresAt: 0, revoked: false });
  saveApis(data);
  return token;
}

function migrateLegacyToken() {
  if (!fs.existsSync(LEGACY_TOKEN_FILE)) return null;
  try {
    const legacyToken = fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8').trim();
    if (!legacyToken) return null;
    const data = loadApis();
    const exists = (data.apis || []).find(a => String(a.token || '').trim() === legacyToken);
    if (exists) return null;
    data.apis = data.apis || [];
    data.apis.push({ token: legacyToken, label: 'Legacy (.token)', duration: 'never', createdAt: Date.now(), expiresAt: 0, revoked: false });
    saveApis(data);
    return legacyToken;
  } catch(e) { warn('Legacy token migration failed:', e.message); return null; }
}

const CONFIG = loadConfig();
const PORT = parseInt(process.env.PORT || CONFIG.port || 7700);
const HOST = process.env.HOST || CONFIG.host || '127.0.0.1';   /* DEFAULT → 127.0.0.1 */

/* ============================================================
   LOG
   ============================================================ */
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}] [TYN]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] [TYN] ⚠`, ...a);
const err = (...a) => console.error(`[${ts()}] [TYN] ✗`, ...a);

/* ============================================================
   OPTIONAL DEPS
   ============================================================ */
let AdmZip = null; try { AdmZip = require('adm-zip'); } catch(_){}
let pty = null; try { pty = require('node-pty'); } catch(_){}

function hasCommand(cmd) {
  try { execSync(`command -v ${cmd} >/dev/null 2>&1`, { stdio: 'ignore', timeout: 2000 }); return true; }
  catch(_) { return false; }
}
const hasScript = hasCommand('script');
const hasUnzip = hasCommand('unzip');
const hasTar = hasCommand('tar');
const has7z = hasCommand('7z') || hasCommand('7za');
const EXEC_MODE = pty ? 'pty' : (hasScript ? 'script' : 'spawn');

/* ============================================================
   NEW FEATURE: LOCALHOST DETECTION + EMBEDDED ADMIN PANEL
   ============================================================ */
function isLocalhost(req) {
  try {
    const sock = req.socket || {};
    const ip = (sock.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  } catch(_) { return false; }
}

/* Self-read: extract lines starting with "//@" from this same file → server.html */
const SERVER_HTML = (() => {
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    const lines = src.split('\n').filter(l => l.startsWith('//@'));
    const out = lines.map(l => l.slice(3)).join('\n');
    if (!out || out.length < 100) {
      warn('Embedded SERVER_HTML looks empty (' + out.length + ' bytes)');
    }
    return out;
  } catch(e) {
    warn('Failed to load embedded SERVER_HTML:', e.message);
    return '<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;background:#111;color:#eee"><h1>⚠ Admin panel tidak tersedia</h1><p>Extraction gagal: ' + e.message + '</p></body></html>';
  }
})();

/* ============================================================
   PROJECT CWD TRACKING
   ============================================================ */
function projectKeyFromToken(token) {
  return 'tk_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}
function safeProjectFile(projectId) {
  const safe = String(projectId || 'default').replace(/[^\w\-]/g, '_');
  return path.join(PROJECT_CWD_DIR, safe);
}
function getProjectCwd(projectId) {
  if (!projectId) return null;
  try {
    const f = safeProjectFile(projectId);
    if (!fs.existsSync(f)) return null;
    const cwd = fs.readFileSync(f, 'utf8').trim();
    if (cwd && fs.existsSync(cwd)) return cwd;
  } catch(_){}
  return null;
}
function saveProjectCwd(projectId, cwd) {
  if (!projectId || !cwd) return;
  try {
    fs.writeFileSync(safeProjectFile(projectId), cwd);
  } catch(_){}
}

/* ============================================================
   COMMAND MAPPER — identity (ync removed, use pkg)
   ============================================================ */
function mapCommand(cmd) {
  return typeof cmd === 'string' ? cmd : '';
}

/* ============================================================
   Y/N DETECTOR
   ============================================================ */
const DEFAULT_YN_PATTERNS = [
  /\[y\/n\]/i, /\(y\/n\)/i, /\[Y\/n\]/, /\(Y\/N\)/,
  /\[yes\/no\]/i, /\(yes\/no\)/i, /continue\?/i, /proceed\?/i,
  /are you sure/i, /do you want to/i, /overwrite\?/i, /replace\?/i,
  /delete\?/i, /confirm\?/i, /\[Y\/n\/a\]/i,
];

function detectYN(text, customPatterns) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const patterns = (customPatterns && customPatterns.length)
    ? [...DEFAULT_YN_PATTERNS, ...customPatterns.map(p => { try { return new RegExp(p,'i'); } catch(_){ return null; } }).filter(Boolean)]
    : DEFAULT_YN_PATTERNS;
  for (const re of patterns) {
    if (re.test(clean)) {
      const lines = clean.split('\n').filter(l => l.trim());
      return (lines[lines.length - 1] || clean).trim().slice(0, 200);
    }
  }
  return null;
}

/* ============================================================
   UTILS
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFileRecursive(dir, ext) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findFileRecursive(full, ext); if (r) return r; }
      else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) return full;
    }
  } catch(_){}
  return null;
}
function findFilesRecursive(dir, ext) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...findFilesRecursive(full, ext));
      else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) out.push(full);
    }
  } catch(_){}
  return out;
}
function isPortFree(port) {
  return new Promise(resolve => {
    const t = http.createServer();
    let done = false;
    t.once('error', () => { if (!done) { done = true; resolve(false); } });
    t.once('listening', () => { if (done) return; done = true; t.close(() => resolve(true)); });
    t.listen(port, '0.0.0.0');
  });
}
async function findFreePort(start = CONFIG.webrunPortStart, end = CONFIG.webrunPortEnd) {
  for (let port = start; port <= end; port++) if (await isPortFree(port)) return port;
  throw new Error(`No free port in ${start}-${end}`);
}

/* ============================================================
   FLUTTER
   ============================================================ */
const Flutter = {
  isInstalled() { return hasCommand('flutter'); },
  getVersion() { try { return execSync('flutter --version 2>/dev/null | head -1', { encoding: 'utf8', timeout: 15000 }).trim(); } catch(_){ return null; } },
  getPath() { try { return execSync('which flutter', { encoding: 'utf8', timeout: 3000 }).trim(); } catch(_){ return null; } },
  async install(send) {
    send('\n=== TYN Flutter Installer ===\n');
    return new Promise(resolve => {
      const script = `
set -e
echo "[1/4] Update packages..."; pkg update -y
echo "[2/4] Install dependencies..."; pkg install -y curl wget git openjdk-17
echo "[3/4] Download Flutter installer..."
curl -L https://raw.githubusercontent.com/ImL1s/termux-flutter-wsl/master/install_flutter_complete.sh -o /tmp/install_flutter.sh
chmod +x /tmp/install_flutter.sh
echo "[4/4] Run installer..."; bash /tmp/install_flutter.sh
`;
      const child = spawn('bash', ['-c', script], { cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' } });
      child.stdout.on('data', d => send(d.toString()));
      child.stderr.on('data', d => send(d.toString()));
      child.on('error', e => resolve({ ok: false, error: e.message }));
      child.on('close', code => {
        if (code === 0) {
          const ok2 = this.isInstalled();
          send(ok2 ? '\n✓ Flutter installed\n' : '\n⚠ Not in PATH\n');
          resolve({ ok: ok2 });
        } else resolve({ ok: false, error: `exit ${code}` });
      });
    });
  },
  async build(appDir, config, send) {
    send('\n=== TYN Flutter Build ===\n');
    const projectDir = path.join(appDir, 'flutter-project');
    const safeName = (config.package || 'app').split('.').pop().replace(/[^a-zA-Z0-9_]/g, '_') || 'app';
    send('[1/5] flutter create...\n');
    const c1 = await this.runCmd(`flutter create --org ${config.package} --project-name ${safeName} --platforms=android "${projectDir}"`, send);
    if (!c1.ok) return { ok: false, error: 'flutter create failed' };
    send('[2/5] Writing lib/main.dart...\n');
    fs.writeFileSync(path.join(projectDir, 'lib', 'main.dart'), this.generateMainDart(config));
    send('[3/5] Adding webview_flutter...\n');
    await this.runCmd(`cd "${projectDir}" && flutter pub add webview_flutter`, send);
    send('[4/5] Patching manifest...\n');
    this.patchManifest(projectDir, config);
    send('[5/5] flutter build apk...\n');
    await this.runCmd(`cd "${projectDir}" && flutter build apk --release --target-platform android-arm64 --no-tree-shake-icons`, send);
    const candidates = [
      path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk'),
      path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-arm64-v8a-release.apk'),
      path.join(projectDir, 'build', 'app', 'outputs', 'apk', 'release', 'app-release.apk'),
    ];
    let apkPath = null;
    for (const p of candidates) if (fs.existsSync(p) && fs.statSync(p).size > 0) { apkPath = p; break; }
    if (!apkPath) apkPath = findFileRecursive(path.join(projectDir, 'build'), '.apk');
    if (!apkPath) return { ok: false, error: 'APK not produced' };
    const finalApk = path.join(appDir, 'app.apk');
    fs.copyFileSync(apkPath, finalApk);
    const finalSize = fs.statSync(finalApk).size;
    if (finalSize === 0) return { ok: false, error: 'APK is 0 bytes' };
    send(`\n✓ APK: ${(finalSize/1024/1024).toFixed(2)} MB\n`);
    return { ok: true, apkPath: finalApk, size: finalSize, method: 'flutter' };
  },
  generateMainDart(config) {
    const urlHandling = config.urlHandling === 'browser' ? 'external' : 'inapp';
    const fullscreen = config.fullscreen ? 'true' : 'false';
    const splashSkip = config.splashSkip ? 'true' : 'false';
    const splashBg = (config.splashBg || '#3f51b5').replace('#','');
    const splashText = (config.splashText || '#ffffff').replace('#','');
    const logoDataUrl = config.logoDataUrl || '';
    const appName = (config.name || 'App').replace(/'/g, "\\'");
    const targetUrl = (config.url || 'https://example.com').replace(/'/g, "\\'");
    return `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() { WidgetsFlutterBinding.ensureInitialized(); runApp(const TynApp()); }
class TynApp extends StatelessWidget {
  const TynApp({super.key});
  @override Widget build(BuildContext context) => MaterialApp(
    title: '${appName}', debugShowCheckedModeBanner: false,
    theme: ThemeData(primarySwatch: Colors.indigo), home: const SplashPage());
}
class SplashPage extends StatefulWidget {
  const SplashPage({super.key});
  @override State<SplashPage> createState() => _SplashPageState();
}
class _SplashPageState extends State<SplashPage> {
  @override void initState() { super.initState(); Timer(const Duration(seconds: 3), () {
    if (mounted) Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomePage()));
  }); }
  @override Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFF${splashBg}),
    body: Stack(children: [
      Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        ${logoDataUrl ? `Container(width: 120, height: 120,
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(24),
            boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 16)]),
          clipBehavior: Clip.antiAlias,
          child: Image.memory(base64Decode('${logoDataUrl.split(',')[1] || ''}'), fit: BoxFit.cover)),
        const SizedBox(height: 24),` : ''}
        const Text('${appName}', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Color(0xFF${splashText}))),
      ])),
      ${splashSkip ? `Positioned(top: 48, right: 24, child: SafeArea(child: TextButton(
        onPressed: () => Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomePage())),
        child: const Text('Skip ›', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold))))),` : ''}
    ]));
}
class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override State<HomePage> createState() => _HomePageState();
}
class _HomePageState extends State<HomePage> {
  late final WebViewController _controller;
  @override void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.white)
      ..setNavigationDelegate(NavigationDelegate(onNavigationRequest: (req) {
        ${urlHandling === 'external' ? `if (!req.url.startsWith('${targetUrl}')) return NavigationDecision.prevent;` : ''}
        return NavigationDecision.navigate;
      }))
      ..loadRequest(Uri.parse('${targetUrl}'));
  }
  @override Widget build(BuildContext context) => Scaffold(body: SafeArea(
    child: ${fullscreen ? 'SizedBox.expand(child: WebViewWidget(controller: _controller))' : 'WebViewWidget(controller: _controller)'}));
}
`;
  },
  patchManifest(projectDir, config) {
    const p = path.join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    if (!fs.existsSync(p)) return;
    let xml = fs.readFileSync(p, 'utf8');
    const perms = [];
    if (config.permissions?.internet !== false) perms.push('android.permission.INTERNET');
    if (config.permissions?.write) perms.push('android.permission.WRITE_EXTERNAL_STORAGE');
    if (config.permissions?.read) perms.push('android.permission.READ_EXTERNAL_STORAGE');
    if (config.permissions?.camera) perms.push('android.permission.CAMERA');
    if (config.permissions?.location) perms.push('android.permission.ACCESS_FINE_LOCATION');
    if (config.permissions?.audio) perms.push('android.permission.RECORD_AUDIO');
    if (config.permissions?.notification) perms.push('android.permission.POST_NOTIFICATIONS');
    const px = perms.map(p2 => `    <uses-permission android:name="${p2}"/>`).join('\n');
    if (!xml.includes('uses-permission android:name="android.permission.INTERNET"')) xml = xml.replace(/(<manifest[^>]*>)/, `$1\n${px}`);
    if (config.url?.startsWith('http://') && !xml.includes('usesCleartextTraffic')) xml = xml.replace(/<application/, '<application android:usesCleartextTraffic="true"');
    fs.writeFileSync(p, xml);
  },
  runCmd(cmd, send) {
    return new Promise(resolve => {
      const c = spawn('bash', ['-c', cmd], { cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' } });
      c.stdout.on('data', d => send(d.toString()));
      c.stderr.on('data', d => send(d.toString()));
      c.on('error', e => resolve({ ok: false, error: e.message }));
      c.on('close', code => resolve({ ok: code === 0, code }));
    });
  }
};

/* ============================================================
   SHARED SHELL PER PROJECT
   ============================================================ */
const projectShells = new Map();

function createProjectShell(projectId, options = {}) {
  const shellBin = options.shell || CONFIG.shell || 'bash';
  const savedCwd = getProjectCwd(projectId);
  const homeDir = process.env.HOME || '/';
  
  // FIX: Paksa shell untuk berjalan di ROOT (folder bridge.js) jika belum ada savedCwd
  // atau jika cwd di config masih berupa "~" / HOME.
  let cwd = savedCwd || (options.cwd || CONFIG.cwd || '~').replace(/^~/, homeDir);
  if (cwd === homeDir || cwd === '~' || !fs.existsSync(cwd)) {
    cwd = ROOT;
  }

  const term = options.term || CONFIG.termType || 'xterm-256color';
  const cols = options.cols || 120;
  const rows = options.rows || 30;
  const env = {
    ...process.env,
    ...(options.env || {}),
    TERM: term,
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };

  let proc = null;
  let isPty = false;
  let hasTty = false;
  let mode = 'spawn';

  if (pty) {
    try {
      proc = pty.spawn(shellBin, ['-i'], { name: term, cols, rows, cwd, env });
      isPty = true; hasTty = true; mode = 'pty';
    } catch(e) { err('pty spawn failed:', e.message); proc = null; }
  }
  if (!proc && hasScript) {
    try {
      proc = spawn('script', ['-qfec', `${shellBin} -i`, '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      hasTty = true; mode = 'script';
    } catch(e) { err('script spawn failed:', e.message); proc = null; }
  }
  if (!proc) {
    try {
      proc = spawn(shellBin, [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      hasTty = false; mode = 'spawn';
    } catch(e) { err('spawn failed:', e.message); return null; }
  }

  const shell = {
    id: projectId, projectId, proc, isPty, hasTty, mode,
    alive: true, ready: false,
    clients: new Set(),
    ynBuffer: '', ynCooldown: 0, lastYNQuestion: '',
    pendingExec: [],
    progressBuf: '', progressTimer: null,
    createdAt: Date.now(), lastActivity: Date.now(),
    cols, rows,
    config: {},
    initialCwd: cwd,
  };

  const writeToProc = (data) => {
    if (!shell.alive) return;
    try {
      if (isPty) proc.write(data);
      else if (proc.stdin && proc.stdin.writable) proc.stdin.write(data);
    } catch(e) { err(`Shell "${projectId}" write failed:`, e.message); }
  };

  shell.write = (data) => {
    if (!shell.alive) return;
    shell.lastActivity = Date.now();
    if (data.length > 16384) {
      for (let i = 0; i < data.length; i += 16384) writeToProc(data.slice(i, i + 16384));
    } else {
      writeToProc(data);
    }
  };

  shell.resize = (c, r) => {
    if (isPty) { try { proc.resize(c, r); shell.cols = c; shell.rows = r; } catch(_){} }
  };

  shell.kill = (sig) => {
    if (shell.progressTimer) { clearTimeout(shell.progressTimer); shell.progressTimer = null; }
    shell.progressBuf = '';
    try { proc.kill(sig || 'SIGHUP'); } catch(_){}
    shell.alive = false;
  };

  const sendOut = (data) => {
    if (!data) return;
    shell.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'out', data })); } catch(_){}
    });
  };

  const flushProgressBuf = () => {
    if (shell.progressTimer) { clearTimeout(shell.progressTimer); shell.progressTimer = null; }
    if (!shell.progressBuf) return;
    const data = shell.progressBuf;
    shell.progressBuf = '';
    sendOut(data + '\n');
  };

  const handleOut = (data) => {
    if (!shell.alive) return;
    const raw = data.toString();
    shell.lastActivity = Date.now();

    shell.ynBuffer += raw;
    if (shell.ynBuffer.length > 4000) shell.ynBuffer = shell.ynBuffer.slice(-2000);

    const customPatterns = shell.config?.behavior?.promptPatterns || [];
    const detectYNEnabled = shell.config?.behavior?.detectYN !== false;
    if (detectYNEnabled) {
      const q = detectYN(raw, customPatterns);
      if (q) {
        const now = Date.now();
        const isSame = q === shell.lastYNQuestion;
        const cooldownExpired = now - shell.ynCooldown > 3000;
        if (!isSame || cooldownExpired) {
          shell.lastYNQuestion = q;
          shell.ynCooldown = now;
          shell.clients.forEach(ws => {
            try { ws.send(JSON.stringify({ type: 'yn-prompt', question: q })); } catch(_){}
          });
        }
      }
    }

    /* Normalize + sanitize — strip "2004" bracketed paste & mode sequences */
    let normalized = raw.replace(/\r\n/g, '\n');
    normalized = normalized
      .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
      .replace(/\x1b\[20[01]~/g, '');

    if (!normalized.includes('\r')) {
      flushProgressBuf();
      sendOut(normalized);
      return;
    }

    const parts = normalized.split('\r');
    if (parts[0]) { flushProgressBuf(); sendOut(parts[0]); }

    const last = parts[parts.length - 1];
    if (!last) return;

    if (last.includes('\n')) {
      if (shell.progressTimer) { clearTimeout(shell.progressTimer); shell.progressTimer = null; }
      shell.progressBuf = '';
      sendOut(last);
    } else {
      shell.progressBuf = last;
      if (!shell.progressTimer) {
        shell.progressTimer = setTimeout(flushProgressBuf, PROGRESS_FLUSH_MS);
      }
    }
  };

  if (isPty) {
    proc.onData(handleOut);
    proc.onExit(({ exitCode }) => {
      if (shell.progressTimer) clearTimeout(shell.progressTimer);
      shell.alive = false;
      shell.clients.forEach(ws => {
        try {
          ws.send(JSON.stringify({ type: 'out', data: `\n[shell exited: ${exitCode}]\n` }));
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        } catch(_){}
      });
      projectShells.delete(projectId);
      log(`Shell "${projectId}" exited (${exitCode})`);
    });
  } else {
    proc.stdout.on('data', handleOut);
    proc.stderr.on('data', handleOut);
    proc.on('error', (e) => err(`Shell "${projectId}" err:`, e.message));
    proc.on('close', (code) => {
      if (shell.progressTimer) clearTimeout(shell.progressTimer);
      shell.alive = false;
      shell.clients.forEach(ws => {
        try {
          ws.send(JSON.stringify({ type: 'out', data: `\n[shell exited: ${code}]\n` }));
          ws.send(JSON.stringify({ type: 'exit', code }));
        } catch(_){}
      });
      projectShells.delete(projectId);
      log(`Shell "${projectId}" exited (${code})`);
    });
  }

  setTimeout(() => {
    if (!shell.alive) return;
    writeToProc('PS1=""\n');
    writeToProc('PS2=""\n');
    if (hasTty) writeToProc('stty -echo 2>/dev/null\n');
    writeToProc('bind "set enable-bracketed-paste off" 2>/dev/null\n');
    /* cwd tracking via PROMPT_COMMAND */
    if (projectId) {
      const cwdFile = safeProjectFile(projectId).replace(/'/g, "'\\''");
      writeToProc(`export __TYN_CWD_FILE='${cwdFile}'\n`);
      writeToProc(`PROMPT_COMMAND='printf "%s" "$PWD" > "$__TYN_CWD_FILE" 2>/dev/null'\n`);
    } else {
      writeToProc('PROMPT_COMMAND=""\n');
    }
    setTimeout(() => {
      if (!shell.alive) return;
      shell.ready = true;
      const pending = shell.pendingExec.splice(0);
      pending.forEach(cmd => writeToProc(cmd + '\n'));
      log(`Shell "${projectId}" ready [${mode}] shell=${shellBin} cwd=${cwd}`);
    }, 300);
  }, 100);

  projectShells.set(projectId, shell);
  return shell;
}

function getOrCreateProjectShell(projectId, options = {}) {
  const existing = projectShells.get(projectId);
  if (existing && existing.alive) return existing;
  if (existing) projectShells.delete(projectId);
  return createProjectShell(projectId, options);
}

/* ============================================================
   IDLE SHELL CLEANUP
   ============================================================ */
setInterval(() => {
  const now = Date.now();
  for (const [id, shell] of projectShells) {
    const idleFor = now - shell.lastActivity;
    const noClients = shell.clients.size === 0;
    if (noClients && idleFor > IDLE_KILL_MS) {
      log(`Auto-killing idle shell "${id}" (idle ${Math.floor(idleFor/60000)}m)`);
      try { shell.kill(); } catch(_){}
      projectShells.delete(id);
    }
  }
}, 5 * 60 * 1000);

/* ============================================================
   ZIP EXTRACTOR
   ============================================================ */
function extractZip(zipPath, destDir, logs) {
  if (AdmZip) {
    try { logs.push('  → adm-zip'); const z = new AdmZip(zipPath); z.extractAllTo(destDir, true);
          logs.push(`  ✓ adm-zip (${z.getEntries().length} entries)`); return true;
    } catch(e) { logs.push(`  ✗ adm-zip: ${e.message}`); }
  }
  if (hasUnzip) {
    try { logs.push('  → unzip'); execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ unzip'); return true;
    } catch(e) { logs.push(`  ✗ unzip: ${e.message}`); }
  }
  if (hasTar) {
    try { logs.push('  → tar'); execSync(`tar -xf "${zipPath}" -C "${destDir}" 2>/dev/null`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ tar'); return true;
    } catch(e) { logs.push(`  ✗ tar: ${e.message}`); }
  }
  if (has7z) {
    try { const b = hasCommand('7z') ? '7z' : '7za'; logs.push('  → 7z');
          execSync(`${b} x -y -o"${destDir}" "${zipPath}"`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ 7z'); return true;
    } catch(e) { logs.push(`  ✗ 7z: ${e.message}`); }
  }
  logs.push('  ⚠ No extractor. Install: pkg install unzip');
  return false;
}

/* ============================================================
   WEB RUNNER
   ============================================================ */
const webRunners = new Map();

function detectEntryPoint(dir, logs) {
  if (fs.existsSync(path.join(dir, 'index.html'))) { logs.push('> Entry: /index.html'); return '/index.html'; }
  if (fs.existsSync(path.join(dir, 'index.htm'))) { logs.push('> Entry: /index.htm'); return '/index.htm'; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.html'))) {
      logs.push(`> Entry: /${e.name}/index.html`); return `/${e.name}/index.html`;
    }
  }
  const htmlFiles = findFilesRecursive(dir, '.html');
  if (htmlFiles.length) {
    const rel = '/' + path.relative(dir, htmlFiles[0]).replace(/\\/g, '/');
    logs.push(`> Entry: ${rel}`); return rel;
  }
  logs.push('> No HTML — listing'); return '/';
}

async function startWebRunner(files, req) {
  const runId = 'wr_' + crypto.randomBytes(6).toString('hex');
  const dir = path.join(WEBRUN_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  const logs = [], fileList = [];
  logs.push(`> Web Runner (${runId})`);
  for (const f of files) {
    const fname = (f.originalname || 'file').replace(/[/\\]/g, '_');
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, f.buffer);
    const sz = f.size < 1024 ? f.size + ' B' : f.size < 1048576 ? (f.size/1024).toFixed(1) + ' KB' : (f.size/1048576).toFixed(2) + ' MB';
    logs.push(`+ ${fname} (${sz})`);
    fileList.push({ name: fname, size: f.size });
    if (/\.zip$/i.test(fname)) {
      logs.push(`> Extract ${fname}...`);
      if (extractZip(fpath, dir, logs)) { try { fs.unlinkSync(fpath); } catch(_){} }
    }
  }
  const entry = detectEntryPoint(dir, logs);
  const port = await findFreePort();
  logs.push(`> Port: ${port}`);

  const sa = express();
  sa.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  sa.use((req, res, next) => {
    const line = `[${new Date().toISOString().slice(11,19)}] ${req.method} ${req.path}`;
    logs.push(line);
    const r = webRunners.get(runId);
    if (r) r.clients.forEach(s => { try { s({ log: line, level: 'dim' }); } catch(_){} });
    next();
  });
  sa.use(express.static(dir, {
    index: 'index.html',
    setHeaders: (res) => { res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Access-Control-Allow-Origin', '*'); }
  }));
  sa.use((req, res) => {
    const sp = path.join(dir, decodeURIComponent(req.path));
    if (!sp.startsWith(dir)) return res.status(403).send('Forbidden');
    if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
      const items = fs.readdirSync(sp, { withFileTypes: true }).map(e =>
        `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory()?'/':''}">${e.name}${e.isDirectory()?'/':''}</a></li>`).join('');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>TYN · ${req.path}</title>
        <style>body{font-family:system-ui;padding:24px;background:#0f0f14;color:#e5e7eb;max-width:900px;margin:0 auto}
        h1{color:#4dd0e1;font-size:20px}.meta{color:#6b7280;font-size:12px;margin-bottom:16px;font-family:monospace}
        ul{list-style:none;padding:0}li{padding:8px 0;border-bottom:1px solid #1a1a24}
        a{color:#93c5fd;text-decoration:none;font-family:monospace;font-size:13px}a:hover{color:#60a5fa}</style>
        </head><body><h1>📁 ${req.path}</h1><div class="meta">TYN Web Runner · ${runId}</div>
        <ul>${items || '<li style="color:#6b7280">(empty)</li>'}</ul></body></html>`);
    }
    res.status(404).send(`<!DOCTYPE html><body style="font-family:system-ui;padding:24px;background:#0f0f14;color:#e5e7eb;text-align:center;padding-top:80px"><h1 style="color:#f87171;font-size:48px">404</h1><p style="color:#9ca3af;font-family:monospace">${req.path}</p></body></html>`);
  });

  const ss = http.createServer(sa);
  await new Promise((resolve, reject) => { ss.once('error', reject); ss.listen(port, '0.0.0.0', resolve); });
  logs.push(`> Listening on :${port}`);

  const reqHost = (req.headers.host || 'localhost').split(':')[0];
  const publicUrl = `http://${reqHost}:${port}${entry}`;
  webRunners.set(runId, { server: ss, port, dir, logs, clients: new Set(), createdAt: Date.now(), entry, publicUrl, fileList });
  log(`WebRunner ${runId} → :${port}`);
  return { runId, port, url: publicUrl, entry, logs, files: fileList };
}

function stopWebRunner(runId) {
  const r = webRunners.get(runId);
  if (!r) return false;
  r.clients.forEach(s => { try { s({ log: '> stopped', level: 'warn' }); } catch(_){} });
  r.clients.clear();
  try { r.server.close(); } catch(_){}
  setTimeout(() => { try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch(_){} }, 500);
  webRunners.delete(runId);
  log(`WebRunner ${runId} stopped`);
  return true;
}
function stopAllWebRunners() {
  const ids = [...webRunners.keys()];
  ids.forEach(stopWebRunner);
  return ids.length;
}

/* ============================================================
   EXPRESS
   ============================================================ */
const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Token, Authorization, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024, files: 50 } });

function auth(req, res, next) {
  const local = isLocalhost(req);
  if (getServerState() !== 'on' && !local) {
    return res.status(503).json({ ok: false, error: 'Bridge is OFF. Enable via tyn.sh', hint: 'Run: bash tyn.sh → option [1]' });
  }
  const token = req.headers['x-api-token'] || req.query.token;
  const v = validateApiToken(token);
  if (!v.ok) {
    const apis = loadApis().apis || [];
    const now = Date.now();
    const validCount = apis.filter(a => !a.revoked && (!a.expiresAt || a.expiresAt > now)).length;
    let hint = 'Check token in Settings, or run: bash tyn.sh → [7]';
    if (validCount === 0) hint = 'No valid API. Generate: bash tyn.sh → [6]';
    else if (v.reason === 'token expired') hint = `Expired ${formatDuration(now - (v.expiredAt || now))} ago. Generate new: tyn.sh → [6]`;
    else if (v.reason === 'token revoked') hint = 'Revoked. Generate new: tyn.sh → [6]';
    return res.status(401).json({ ok: false, error: 'Invalid API: ' + v.reason, reason: v.reason,
      expiredAt: v.expiredAt || null, validTokenCount: validCount, totalTokenCount: apis.length, hint });
  }
  req.api = v.api;
  req.tokenExpiresIn = v.expiresIn;
  next();
}

function serveIndex(req, res) {
  const htmlPath = path.join(ROOT, INDEX_FILE);
  if (!fs.existsSync(htmlPath)) return res.status(404).send('index.html not found');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const proto = (req.secure || req.headers['x-forwarded-proto'] === 'https') ? 'wss' : 'ws';
  const host = req.headers.host || `localhost:${PORT}`;
  const token = getFirstValidToken();
  html = html.replace(/__TYN_WS_URL__/g, `${proto}://${host}`);
  html = html.replace(/__TYN_TOKEN__/g, token);
  html = html.replace(/__TYN_ENTRY_URL__/g, `http://${host}${BASE_PATH}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

app.get('/', (req, res) => res.redirect(BASE_PATH));
app.get('/index.html', serveIndex);

/* ============================================================
   NEW ROUTE: /admin — serve embedded admin panel (server.html)
   ============================================================ */
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(SERVER_HTML);
});
app.get('/admin/', (req, res) => res.redirect('/admin'));

app.use(express.static(ROOT, { index: false }));

/* ─── PUBLIC ─── */
app.get('/api/state', (req, res) => {
  const apis = loadApis().apis || [];
  const now = Date.now();
  const valid = apis.filter(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
  res.json({
    ok: true, state: getServerState(), version: VERSION, running: true,
    validTokenCount: valid.length,
    expiredTokenCount: apis.filter(a => !a.revoked && a.expiresAt && a.expiresAt <= now).length,
    revokedTokenCount: apis.filter(a => a.revoked).length,
    totalTokenCount: apis.length,
    shells: projectShells.size, webrunners: webRunners.size,
    hint: valid.length === 0 ? 'No valid API. Generate: bash tyn.sh → [6]' : null,
  });
});

/* ─── PROTECTED ─── */
app.get('/check', auth, (req, res) => {
  res.json({
    ok: true, server: 'TYN Bridge', version: VERSION, port: PORT,
    execMode: EXEC_MODE, hasPty: !!pty, hasScript, hasUnzip, hasTar, has7z, hasAdmZip: !!AdmZip,
    flutterInstalled: Flutter.isInstalled(), flutterVersion: Flutter.getVersion(),
    entry: `http://localhost:${PORT}${BASE_PATH}`, ws: `ws://localhost:${PORT}`,
    admin: `http://localhost:${PORT}/admin`,
    token: req.api.token.slice(0, 12) + '...', apiLabel: req.api.label,
    apiExpiresAt: req.api.expiresAt || null, apiExpiresIn: req.tokenExpiresIn,
    apiExpiresInHuman: formatDuration(req.tokenExpiresIn),
    uptime: process.uptime(), platform: os.platform(), hostname: os.hostname(),
    webrunners: webRunners.size, shells: projectShells.size,
    nanoFiles: fs.existsSync(NANO_DIR) ? fs.readdirSync(NANO_DIR).length : 0,
    config: { shell: CONFIG.shell, termType: CONFIG.termType, cwd: CONFIG.cwd, port: CONFIG.port },
  });
});

app.get('/api/check', auth, (req, res) => res.json({ ok: true, version: VERSION, port: PORT, execMode: EXEC_MODE,
  flutter: Flutter.isInstalled(), webrunners: webRunners.size, shells: projectShells.size, state: getServerState() }));

app.post('/api/map', auth, (req, res) => res.json({ ok: true, input: req.body.cmd, output: mapCommand(req.body.cmd) }));
app.post('/api/detect-yn', auth, (req, res) => res.json({ ok: true, detected: detectYN(req.body.text, req.body.patterns), text: req.body.text }));

/* ─── SESSION / PROJECT MANAGEMENT ─── */
app.get('/api/sessions', auth, (req, res) => {
  const list = [...projectShells.entries()].map(([id, s]) => ({
    id, mode: s.mode, alive: s.alive, ready: s.ready,
    clients: s.clients.size,
    createdAt: s.createdAt, lastActivity: s.lastActivity,
    idleFor: Date.now() - s.lastActivity,
    cols: s.cols, rows: s.rows,
    projectId: s.projectId,
  }));
  res.json({ ok: true, sessions: list, total: list.length });
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const s = projectShells.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
  try { s.kill(); } catch(_){}
  projectShells.delete(req.params.id);
  res.json({ ok: true, killed: req.params.id });
});

app.post('/api/sessions/:id/reset', auth, (req, res) => {
  const s = projectShells.get(req.params.id);
  if (s) {
    try { s.kill(); } catch(_){}
    projectShells.delete(req.params.id);
  }
  res.json({ ok: true, reset: req.params.id, hint: 'Reconnect to spawn new shell' });
});

/* ─── CONFIG ─── */
app.get('/api/config', auth, (req, res) => {
  try {
    const configs = [];
    if (fs.existsSync(CONFIGS_DIR)) fs.readdirSync(CONFIGS_DIR).forEach(id => {
      const p = path.join(CONFIGS_DIR, id, 'config.json');
      if (fs.existsSync(p)) try { configs.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch(_){}
    });
    res.json({ ok: true, configs });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/config/:id', auth, (req, res) => {
  const p = path.join(CONFIGS_DIR, req.params.id, 'config.json');
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
  try { res.json({ ok: true, config: JSON.parse(fs.readFileSync(p, 'utf8')) }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/config', auth, (req, res) => {
  try {
    const cfg = req.body;
    const id = cfg.id || 'cfg_' + crypto.randomBytes(6).toString('hex');
    const dir = path.join(CONFIGS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cfg.id = id; cfg.savedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true, id, config: cfg });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.put('/api/config/:id', auth, (req, res) => {
  try {
    const dir = path.join(CONFIGS_DIR, req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'not found' });
    const cfg = req.body; cfg.id = req.params.id; cfg.savedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true, config: cfg });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/config/:id', auth, (req, res) => {
  const dir = path.join(CONFIGS_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

/* ─── FLUTTER ─── */
app.get('/api/flutter/status', auth, (req, res) => {
  const i = Flutter.isInstalled();
  res.json({ ok: true, installed: i, version: i ? Flutter.getVersion() : null, path: i ? Flutter.getPath() : null });
});
app.post('/api/flutter/install', auth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify({ type: 'log', data: d })}\n\n`);
  const sendE = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  sendE({ type: 'start', message: 'Installing Flutter...' });
  const r = await Flutter.install(send);
  sendE({ type: 'done', ...r });
  res.end();
});
app.post('/api/flutter/build', auth, upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const sendE = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const send = d => sendE({ type: 'log', data: d });
  try {
    if (!Flutter.isInstalled()) { sendE({ type: 'error', message: 'Flutter not installed' }); return res.end(); }
    const config = JSON.parse(req.body.config);
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    if (req.files?.zip) fs.writeFileSync(path.join(appDir, 'source.zip'), req.files.zip[0].buffer);
    if (config.logoDataUrl) { const b64 = config.logoDataUrl.split(',')[1]; if (b64) fs.writeFileSync(path.join(appDir, 'logo.png'), Buffer.from(b64, 'base64')); }
    sendE({ type: 'start', appId });
    const r = await Flutter.build(appDir, config, send);
    if (r.ok) {
      const meta = { id: appId, name: config.name, package: config.package, version: config.version,
        logoDataUrl: config.logoDataUrl || null, size: r.size, createdAt: Date.now(), status: 'success', method: 'flutter' };
      fs.writeFileSync(path.join(appDir, 'meta.json'), JSON.stringify(meta, null, 2));
      sendE({ type: 'done', ok: true, app: meta, downloadUrl: `/api/download/${appId}?token=${req.api.token}` });
    } else sendE({ type: 'error', message: r.error });
  } catch(e) { sendE({ type: 'error', message: e.message }); }
  res.end();
});

/* ─── BUILD ─── */
app.post('/api/build', auth, upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    if (!Flutter.isInstalled()) {
      return res.status(400).json({
        ok: false, error: 'Flutter not installed. Real APK build requires Flutter.',
        hint: 'Install: curl -X POST http://localhost:' + PORT + '/api/flutter/install -H "X-API-Token: <token>"',
        flutterInstalled: false,
      });
    }
    const config = JSON.parse(req.body.config);
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    if (req.files?.zip) fs.writeFileSync(path.join(appDir, 'source.zip'), req.files.zip[0].buffer);
    if (req.files?.video) fs.writeFileSync(path.join(appDir, 'splash.mp4'), req.files.video[0].buffer);
    if (config.logoDataUrl) { const b64 = config.logoDataUrl.split(',')[1]; if (b64) fs.writeFileSync(path.join(appDir, 'logo.png'), Buffer.from(b64, 'base64')); }
    const br = await Flutter.build(appDir, config, () => {});
    const meta = { id: appId, name: config.name, package: config.package, version: config.version,
      logoDataUrl: config.logoDataUrl || null, size: br.size || 0, createdAt: Date.now(),
      status: br.ok ? 'success' : 'error', error: br.error || null, method: br.method || 'flutter' };
    fs.writeFileSync(path.join(appDir, 'meta.json'), JSON.stringify(meta, null, 2));
    if (!br.ok) return res.status(500).json({ ok: false, error: br.error, app: meta });
    res.json({ ok: true, app: meta, downloadUrl: `/api/download/${appId}?token=${req.api.token}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ─── DOWNLOAD ─── */
app.get('/api/download/:id', auth, async (req, res) => {
  const apk = path.join(APPS_DIR, req.params.id, 'app.apk');
  if (!fs.existsSync(apk)) return res.status(404).json({ ok: false, error: 'APK not found', hint: `Poll GET /api/build/status/${req.params.id}` });
  let stat;
  try { stat = fs.statSync(apk); }
  catch(e) { return res.status(500).json({ ok: false, error: 'stat failed: ' + e.message }); }
  if (!stat.size) return res.status(425).json({ ok: false, error: 'APK is 0 bytes. Build failed.' });

  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.apk"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const s = fs.createReadStream(apk);
  s.on('error', e => { err('Stream error:', e.message); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); else res.destroy(); });
  s.pipe(res);
  log(`Download ${req.params.id}: ${(stat.size/1024/1024).toFixed(2)} MB`);
});

/* ─── BUILD STATUS / APPS ─── */
app.get('/api/build/status/:id', auth, (req, res) => {
  const mp = path.join(APPS_DIR, req.params.id, 'meta.json');
  const ap = path.join(APPS_DIR, req.params.id, 'app.apk');
  if (!fs.existsSync(mp)) return res.json({ ok: false, status: 'not_found' });
  let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); }
  catch(_) { return res.json({ ok: false, status: 'invalid_meta' }); }
  let sz = 0, rdy = false;
  if (fs.existsSync(ap)) { sz = fs.statSync(ap).size; rdy = sz > 0; }
  res.json({ ok: true, id: req.params.id, meta, apkReady: rdy, apkSize: sz,
    downloadUrl: rdy ? `/api/download/${req.params.id}?token=${req.api.token}` : null });
});
app.get('/api/apps', auth, (req, res) => {
  try {
    const apps = [];
    if (fs.existsSync(APPS_DIR)) fs.readdirSync(APPS_DIR).forEach(id => {
      const mp = path.join(APPS_DIR, id, 'meta.json');
      if (fs.existsSync(mp)) try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const ap = path.join(APPS_DIR, id, 'app.apk');
        m.apkSize = fs.existsSync(ap) ? fs.statSync(ap).size : 0;
        m.apkReady = m.apkSize > 0;
        apps.push(m);
      } catch(_){}
    });
    res.json({ ok: true, apps });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/apps/:id', auth, (req, res) => {
  const d = path.join(APPS_DIR, req.params.id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  res.json({ ok: true });
});

/* ─── WEB RUNNER ─── */
app.post('/api/webrun/start', auth, upload.fields([{ name: 'files', maxCount: 50 }]), async (req, res) => {
  try {
    const files = req.files?.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No files' });
    const r = await startWebRunner(files, req);
    res.json({ ok: true, ...r });
  } catch(e) { err('WebRunner:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/webrun/logs/:runId', auth, (req, res) => {
  const r = webRunners.get(req.params.runId);
  if (!r) return res.status(404).json({ ok: false, error: 'not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = o => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch(_){} };
  send({ log: '> Connected', level: 'info' });
  r.logs.forEach(l => send({ log: l, level: 'dim' }));
  r.clients.add(send);
  const ka = setInterval(() => send({ log: '', level: 'heartbeat' }), 25000);
  req.on('close', () => { clearInterval(ka); r.clients.delete(send); });
});
app.post('/api/webrun/stop/:runId', auth, (req, res) => res.json({ ok: true, stopped: stopWebRunner(req.params.runId) }));
app.get('/api/webrun/list', auth, (req, res) => {
  const list = [...webRunners.entries()].map(([id, r]) => ({
    runId: id, port: r.port, entry: r.entry, publicUrl: r.publicUrl,
    createdAt: r.createdAt, clients: r.clients.size, files: r.fileList.length,
  }));
  res.json({ ok: true, runners: list });
});
app.get('/api/webrun/status/:runId', auth, (req, res) => {
  const r = webRunners.get(req.params.runId);
  if (!r) return res.json({ ok: false, status: 'not_found' });
  res.json({ ok: true, status: 'running', runId: req.params.runId, port: r.port,
    entry: r.entry, publicUrl: r.publicUrl, uptime: Date.now() - r.createdAt,
    files: r.fileList, logCount: r.logs.length });
});

/* ─── NANO (auto chmod scripts) ─── */
app.post('/api/nano/save', auth, express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (!filename || typeof content !== 'string') return res.status(400).json({ ok: false, error: 'invalid' });
    const safe = String(filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    if (!safe) return res.status(400).json({ ok: false, error: 'invalid filename' });
    const p = path.join(NANO_DIR, safe);
    fs.writeFileSync(p, content, 'utf8');
    if (SCRIPT_EXT.test(safe)) { try { fs.chmodSync(p, 0o755); } catch(_){} }
    res.json({ ok: true, path: path.relative(ROOT, p), size: fs.statSync(p).size, filename: safe });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/nano/files', auth, (req, res) => {
  try {
    const files = fs.existsSync(NANO_DIR)
      ? fs.readdirSync(NANO_DIR).filter(f => { try { return fs.statSync(path.join(NANO_DIR, f)).isFile(); } catch(_) { return false; } })
          .map(f => { const st = fs.statSync(path.join(NANO_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
      : [];
    res.json({ ok: true, files });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/nano/get/:filename', auth, (req, res) => {
  try {
    const safe = String(req.params.filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    const p = path.join(NANO_DIR, safe);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, filename: safe, content: fs.readFileSync(p, 'utf8') });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/nano/:filename', auth, (req, res) => {
  try {
    const safe = String(req.params.filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    const p = path.join(NANO_DIR, safe);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ============================================================
   WEBSOCKET — SHARED SHELL PER PROJECT
   ============================================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/term' });

/* Regex untuk intercept heredoc nano save dari client */
const NANO_HEREDOC_RE = /^cat > '([^']+)' << '(TYN_EOF_[^']+)'\n([\s\S]*)\n\2\n$/;

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const session = url.searchParams.get('session') || 'default';
  const explicitProject = url.searchParams.get('project');

  if (getServerState() !== 'on' && !isLocalhost(req)) {
    ws.send(JSON.stringify({ type: 'error', data: 'Bridge is OFF. Enable via tyn.sh → [1]' }));
    return ws.close();
  }

  const v = validateApiToken(token);
  if (!v.ok) {
    let msg = 'Invalid API: ' + v.reason;
    if (v.reason === 'token expired') msg += ` (expired ${formatDuration(Date.now() - (v.expiredAt || Date.now()))} ago)`;
    msg += '\n\nGenerate new: bash tyn.sh → [6]';
    ws.send(JSON.stringify({ type: 'error', data: msg }));
    return ws.close();
  }

  /* Project key: explicit param → token hash → session fallback */
  const projectId = explicitProject || projectKeyFromToken(v.api.token) || session;

  log(`WS connect: session=${session} project=${projectId} @${req.socket.remoteAddress}`);

  const shell = getOrCreateProjectShell(projectId, {
    cols: 120, rows: 30,
    cwd: CONFIG.cwd, shell: CONFIG.shell, term: CONFIG.termType,
  });

  if (!shell) {
    ws.send(JSON.stringify({ type: 'error', data: 'Failed to create shell. Install: npm install node-pty' }));
    return ws.close();
  }

  shell.clients.add(ws);

  const expInfo = v.expiresIn !== null
    ? (v.expiresIn > 0 ? ` (expires in ${formatDuration(v.expiresIn)})` : ' (expired)')
    : ' (never expires)';

  ws.send(JSON.stringify({
    type: 'out',
    data: `* ${VERSION_FULL} connected\n* session: ${session}\n* project: ${projectId}\n* cwd: ${shell.initialCwd}\n* mode: ${shell.mode}${shell.hasTty ? ' (tty)' : ' (no-tty)'}\n* shell: ${CONFIG.shell} · term: ${CONFIG.termType}\n* api: ${v.api.label || 'default'}${expInfo}\n* commands: pkg (e.g. pkg install python)\n\n`
  }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'exec': {
          if (!shell.alive) {
            ws.send(JSON.stringify({ type: 'error', data: 'Shell dead. Reconnect.' }));
            break;
          }
          const cmd = mapCommand(msg.cmd || '');
          if (!cmd.trim()) break;

          if (!shell.ready) {
            shell.pendingExec.push(cmd);
            log(`Shell "${projectId}" queued exec (not ready): ${cmd.slice(0, 60)}`);
            break;
          }

          shell.write(cmd + '\n');
          break;
        }
        case 'input': {
          if (!shell.alive || !msg.data) break;

          /* Intercept nano heredoc saves → write directly to disk (bypass shell) */
          const m = String(msg.data).match(NANO_HEREDOC_RE);
          if (m) {
            const [, filename, , content] = m;
            const safeName = filename.replace(/[/\\]/g, '_').replace(/^\.+/, '');
            const targetDir = getProjectCwd(projectId) || shell.initialCwd || process.env.HOME || '/';
            const targetPath = path.join(targetDir, safeName);
            try {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              fs.writeFileSync(targetPath, content, 'utf8');
              if (SCRIPT_EXT.test(safeName)) { try { fs.chmodSync(targetPath, 0o755); } catch(_){} }
              ws.send(JSON.stringify({ type: 'out', data: `[nano] ✓ saved ${safeName} (${content.length} bytes) → ${targetPath}\n` }));
              log(`Nano save intercepted: ${safeName} (${content.length}b) → ${targetPath}`);
            } catch(e) {
              ws.send(JSON.stringify({ type: 'error', data: `[nano] save failed: ${e.message}` }));
            }
            break;
          }

          shell.write(msg.data);
          break;
        }
        case 'kill': {
          if (shell.alive) shell.write('\x03');
          break;
        }
        case 'resize': {
          if (shell.alive) shell.resize(msg.cols || 120, msg.rows || 30);
          break;
        }
        case 'config': {
          shell.config = msg.config || {};
          ws.send(JSON.stringify({ type: 'config-ack', ok: true }));
          break;
        }
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
        }
        case 'yn-answer': {
          if (shell.alive) shell.write((msg.answer || 'y') + '\n');
          break;
        }
        case 'save-file': {
          /* Optional direct save endpoint (better than heredoc) */
          try {
            const { filename, content, chmod } = msg;
            const safeName = String(filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
            const targetDir = getProjectCwd(projectId) || shell.initialCwd || process.env.HOME || '/';
            const targetPath = path.join(targetDir, safeName);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content || '', 'utf8');
            const shouldChmod = chmod !== false && SCRIPT_EXT.test(safeName);
            if (shouldChmod) { try { fs.chmodSync(targetPath, 0o755); } catch(_){} }
            ws.send(JSON.stringify({ type: 'out', data: `[save] ✓ ${safeName} (${(content||'').length} bytes)${shouldChmod ? ' [exec]' : ''}\n` }));
          } catch(e) {
            ws.send(JSON.stringify({ type: 'error', data: `[save] ${e.message}` }));
          }
          break;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', data: 'Unknown: ' + msg.type }));
      }
    } catch(e) {
      ws.send(JSON.stringify({ type: 'error', data: 'Bad msg: ' + e.message }));
    }
  });

  ws.on('close', () => {
    if (shell) shell.clients.delete(ws);
    log(`WS detach: ${projectId} (${shell ? shell.clients.size : 0} remaining)`);
  });
  ws.on('error', e => err(`WS err:`, e.message));
});

/* ============================================================
   BOOT
   ============================================================ */
const migratedToken = migrateLegacyToken();
if (migratedToken) log('Migrated legacy .token → apis.json');

const autoToken = ensureDefaultApi();
if (autoToken) {
  log('');
  log('═══════════════════════════════════════════════════════');
  log(' AUTO-GENERATED DEFAULT API (permanent)');
  log(' Token:', autoToken);
  log('═══════════════════════════════════════════════════════');
  log('');
}

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  Object.values(ifaces).forEach(l => l.forEach(i => { if (i.family === 'IPv4' && !i.internal) addrs.push(i.address); }));
  const apis = loadApis().apis || [];
  const now = Date.now();
  const valid = apis.filter(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
  const state = getServerState();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log(`║   ${VERSION_FULL.padEnd(56)}║`);
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║ Bind    : ${HOST}:${PORT}`.padEnd(60) + '║');
  console.log(`║ Entry   : http://localhost:${PORT}/index.html`.padEnd(60) + '║');
  console.log(`║ Admin   : http://localhost:${PORT}/admin`.padEnd(60) + '║');
  if (HOST === '0.0.0.0' || HOST === '::') {
    addrs.forEach(a => console.log(`║ Remote  : http://${a}:${PORT}/index.html`.padEnd(60) + '║'));
  }
  console.log(`║ WS      : ws://localhost:${PORT}/term`.padEnd(60) + '║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║ State            : ${state === 'on' ? '✓ ON' : '○ OFF (via tyn.sh)'}`.padEnd(60) + '║');
  console.log(`║ APIs valid/total : ${valid.length}/${apis.length}`.padEnd(60) + '║');
  console.log(`║ Shell / TERM     : ${CONFIG.shell} / ${CONFIG.termType}`.padEnd(60) + '║');
  console.log(`║ Exec mode        : ${EXEC_MODE} (shared/project)`.padEnd(60) + '║');
  console.log(`║ node-pty         : ${pty ? '✓' : '✗ (fallback)'}`.padEnd(60) + '║');
  console.log(`║ Flutter          : ${Flutter.isInstalled() ? '✓' : '✗'}`.padEnd(60) + '║');
  console.log(`║ Web Runner       : :${CONFIG.webrunPortStart}-${CONFIG.webrunPortEnd}`.padEnd(60) + '║');
  console.log(`║ Progress flush   : ${PROGRESS_FLUSH_MS}ms`.padEnd(60) + '║');
  console.log(`║ Idle cleanup     : ${IDLE_KILL_MS/60000} min`.padEnd(60) + '║');
  console.log(`║ Project tracking : ✓ cwd shared per token`.padEnd(60) + '║');
  console.log(`║ Admin embedded   : ✓ ${SERVER_HTML.length} bytes`.padEnd(60) + '║');
  console.log(`║ Localhost bypass : ✓ admin can bootstrap`.padEnd(60) + '║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  if (state !== 'on') console.log('║ ⚠ State OFF — Enable via /admin panel atau tyn.sh → [1]     ║');
  if (valid.length === 0) console.log('║ ⚠ No valid API — Generate: tyn.sh → [6]                    ║');
  else {
    console.log(`║ First valid token: ${valid[0].token.slice(0, 24)}...`.padEnd(60) + '║');
    if (valid[0].expiresAt) console.log(`║ Token expires in : ${formatDuration(valid[0].expiresAt - now)}`.padEnd(60) + '║');
  }
  console.log('╚═══════════════════════════════════════════════════════════╝');
});

function shutdown(sig) {
  console.log(`\n[TYN] ${sig} — shutting down...`);
  const n = stopAllWebRunners();
  if (n) log(`Stopped ${n} runners`);
  projectShells.forEach((s) => { try { s.kill(); } catch(_){} });
  projectShells.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => err('Uncaught:', e));
process.on('unhandledRejection', e => err('Unhandled:', e));

/* ============================================================
   EMBEDDED ADMIN PANEL (server.html)
   Served at GET /admin — extracted at runtime from lines starting with "//@"
   ============================================================ */
//@<!DOCTYPE html>
//@<html lang="id">
//@<head>
//@<meta charset="UTF-8">
//@<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
//@<meta name="theme-color" content="#3f51b5">
//@<title>Console TYN</title>
//@<style>
//@*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
//@:root{--primary:#3f51b5;--primary-dark:#303f9f;--primary-light:#7986cb;--accent:#ff4081;--danger:#f44336;--success:#4ade80;--warning:#fbbf24;--bg-term:#0a0a0a;--term-fs:13px}
//@html,body{height:100%}
//@body{font-family:Roboto,'Helvetica Neue',Arial,sans-serif;background:#f5f5f5;color:#212121;overflow:hidden;height:100dvh;-webkit-user-select:none;user-select:none}
//@.view{position:absolute;inset:0;display:none;flex-direction:column;overflow:hidden;background:#f5f5f5}
//@.view.active{display:flex}
//@svg{display:block}
//@.appbar{height:56px;background:linear-gradient(180deg,var(--primary),var(--primary-dark));color:#fff;display:flex;align-items:center;padding:0 4px;box-shadow:0 2px 4px rgba(0,0,0,.28);z-index:10;flex-shrink:0}
//@.appbar .icon-btn{width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:#fff;cursor:pointer;border-radius:50%;flex-shrink:0}
//@.appbar .icon-btn:active{background:rgba(255,255,255,.18)}
//@.appbar h1{font-size:18px;font-weight:500;margin-left:8px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
//@.appbar .pill{background:rgba(255,255,255,.2);padding:5px 10px;border-radius:12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px;margin-right:8px}
//@.appbar .pill.online{background:rgba(74,222,128,.3)}
//@.appbar .pill.offline{background:rgba(244,67,54,.3)}
//@
//@.content{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 12px 24px;background:#f5f5f5}
//@.banner{width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,#3f51b5,#7e57c2 55%,#ec407a);overflow:hidden;position:relative;flex-shrink:0;border-radius:6px;margin-bottom:12px}
//@.banner img{width:100%;height:100%;object-fit:cover;display:block}
//@.banner-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.55);pointer-events:none}
//@.banner-overlay .logo{font-size:44px;font-weight:800;letter-spacing:.14em;line-height:1}
//@.banner-overlay .tag{font-size:10px;letter-spacing:.35em;margin-top:6px;opacity:.9}
//@
//@.card{background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.24);margin-bottom:12px;padding:14px}
//@.card-title{font-size:13px;font-weight:600;color:#424242;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between}
//@.card-title .badge{background:#e0e0e0;color:#424242;padding:2px 8px;border-radius:10px;font-size:11px;text-transform:none;letter-spacing:0}
//@
//@.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
//@.stat{background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12);padding:14px;position:relative;overflow:hidden}
//@.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--primary),var(--accent))}
//@.stat.green::before{background:linear-gradient(90deg,#4ade80,#22c55e)}
//@.stat.red::before{background:linear-gradient(90deg,#f87171,#ef4444)}
//@.stat.gold::before{background:linear-gradient(90deg,#fbbf24,#f59e0b)}
//@.stat-label{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:#757575;margin-bottom:4px;font-weight:600}
//@.stat-value{font-size:22px;font-weight:700;color:#212121;line-height:1.1}
//@.stat-value.green{color:#2e7d32}.stat-value.red{color:#c62828}.stat-value.gold{color:#b45309}
//@
//@.conn-card{display:flex;align-items:center;gap:12px}
//@.conn-icon{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:#e0e0e0;transition:background .2s}
//@.conn-icon.online{background:linear-gradient(135deg,#4ade80,#22c55e)}
//@.conn-icon.offline{background:linear-gradient(135deg,#f87171,#ef4444)}
//@.conn-icon.checking{background:linear-gradient(135deg,#fbbf24,#f59e0b);animation:pulse 1s infinite}
//@.conn-icon svg{fill:#fff;width:22px;height:22px}
//@.conn-info{flex:1;min-width:0}
//@.conn-info .st{font-size:14px;font-weight:600;margin-bottom:2px}
//@.conn-info .hint{font-size:11px;color:#757575;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
//@
//@.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 16px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;border:none;border-radius:4px;cursor:pointer;background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:#fff;box-shadow:0 2px 5px rgba(0,0,0,.22);font-family:inherit}
//@.btn:active{transform:translateY(1px)}
//@.btn.full{width:100%}
//@.btn.secondary{background:#eceff1;color:#37474f;box-shadow:0 1px 3px rgba(0,0,0,.15)}
//@.btn.success{background:linear-gradient(135deg,#4ade80,#22c55e);color:#fff}
//@.btn.danger{background:linear-gradient(135deg,#f87171,#ef4444);color:#fff}
//@.btn.warning{background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#fff}
//@.btn[disabled]{opacity:.5;pointer-events:none}
//@.btn svg{width:16px;height:16px;fill:currentColor}
//@.btn-row{display:flex;gap:8px;flex-wrap:wrap}
//@
//@.input-group{margin-bottom:12px}
//@.input-group label{display:block;font-size:11px;color:#757575;font-weight:600;margin-bottom:5px;text-transform:uppercase;letter-spacing:.05em}
//@.input-group input,.input-group select,.input-group textarea{width:100%;padding:10px 12px;font-size:13px;border:1px solid #e0e0e0;border-radius:4px;outline:none;font-family:inherit;background:#fafafa;color:#212121}
//@.input-group input:focus,.input-group select:focus,.input-group textarea:focus{border-color:var(--primary);background:#fff}
//@
//@table{width:100%;border-collapse:collapse;font-size:12px}
//@th{text-align:left;padding:8px 10px;color:#757575;font-size:10px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #e0e0e0;font-weight:700}
//@td{padding:9px 10px;border-bottom:1px solid #f5f5f5;font-size:12px;color:#424242}
//@tr:hover td{background:#fafafa}
//@td.mono{font-family:'Roboto Mono','Courier New',monospace;font-size:11px}
//@td.ok{color:#2e7d32;font-weight:600}
//@td.err{color:#c62828;font-weight:600}
//@td.warn{color:#b45309;font-weight:600}
//@td.muted{color:#9e9e9e}
//@
//@.empty{text-align:center;padding:36px 20px;color:#9e9e9e}
//@.empty svg{width:56px;height:56px;margin:0 auto 12px;fill:#e0e0e0}
//@.empty h3{font-size:14px;color:#616161;margin-bottom:6px;font-weight:600}
//@.empty p{font-size:12px;line-height:1.5}
//@
//@.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(80px);background:#323232;color:#fff;padding:12px 20px;border-radius:4px;font-size:13px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:all .25s;z-index:400;max-width:88%;text-align:center}
//@.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
//@.toast.success{background:#2e7d32}
//@.toast.error{background:#c62828}
//@.toast.warning{background:#ef6c00}
//@
//@.sidebar-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50;opacity:0;pointer-events:none;transition:opacity .22s}
//@.sidebar-overlay.show{opacity:1;pointer-events:auto}
//@.sidebar{position:fixed;top:0;bottom:0;left:0;width:280px;max-width:82vw;background:#fff;z-index:51;transform:translateX(-100%);transition:transform .25s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;box-shadow:3px 0 12px rgba(0,0,0,.35)}
//@.sidebar.show{transform:translateX(0)}
//@.sidebar-banner{width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,#3f51b5,#7e57c2 55%,#ec407a);overflow:hidden;position:relative;flex-shrink:0}
//@.sidebar-banner img{width:100%;height:100%;object-fit:cover;display:block}
//@.sidebar-banner .banner-overlay .logo{font-size:26px;letter-spacing:.1em}
//@.sidebar-banner .banner-overlay .tag{font-size:9px;letter-spacing:.3em}
//@.sidebar-items{flex:1;overflow-y:auto;padding:8px 0}
//@.sidebar-header{padding:12px 20px 4px;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#9e9e9e;font-weight:700}
//@.sidebar-item{display:flex;align-items:center;gap:14px;padding:11px 20px;cursor:pointer;color:#424242;font-size:13px;font-weight:500}
//@.sidebar-item:active{background:#eee}
//@.sidebar-item.active{background:#e8eaf6;color:#303f9f;font-weight:600;border-left:3px solid var(--primary);padding-left:17px}
//@.sidebar-item svg{width:20px;height:20px;fill:#616161;flex-shrink:0}
//@.sidebar-item.active svg{fill:#303f9f}
//@.sidebar-divider{height:1px;background:#e0e0e0;margin:8px 0}
//@.sidebar-footer{padding:12px 20px;border-top:1px solid #eee;font-size:11px;color:#9e9e9e;text-align:center}
//@.sidebar-footer b{color:var(--primary)}
//@
//@.term-box{background:#0a0a0a;border-radius:6px;padding:12px;font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;line-height:1.5;min-height:200px;max-height:52vh;overflow-y:auto;-webkit-user-select:text;user-select:text}
//@.term-box .t-cmd{color:#7dd3fc}
//@.term-box .t-ok{color:#4ade80}
//@.term-box .t-err{color:#f87171}
//@.term-box .t-warn{color:#fbbf24}
//@.term-box .t-dim{color:#6b7280}
//@
//@.term-input-row{display:flex;gap:6px;margin-top:8px}
//@.term-input-row input{flex:1;background:#0a0a0a;border:1px solid #2a2a2a;color:#4ade80;padding:10px 12px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px;outline:none}
//@.term-input-row input:focus{border-color:var(--primary)}
//@
//@.code{background:#0a0a0a;color:#e0e0e0;padding:12px;border-radius:4px;font-family:'Roboto Mono','Courier New',monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;-webkit-user-select:text;user-select:text}
//@
//@.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:none;align-items:center;justify-content:center;padding:20px}
//@.modal-overlay.show{display:flex}
//@.modal{background:#fff;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.45);width:100%;max-width:400px;overflow:hidden;animation:popIn .18s ease;max-height:90vh;display:flex;flex-direction:column;color:#212121}
//@.modal-title{padding:18px 20px 4px;font-size:16px;font-weight:600;color:#212121}
//@.modal-body{padding:8px 20px 16px;overflow-y:auto;font-size:14px;color:#424242;line-height:1.5}
//@.modal-actions{display:flex;justify-content:flex-end;padding:6px 12px 12px;gap:2px;border-top:1px solid #eee}
//@.modal-actions button{background:transparent;border:none;padding:10px 16px;font-size:13px;font-weight:600;text-transform:uppercase;color:var(--primary);cursor:pointer;border-radius:3px;font-family:inherit}
//@.modal-actions button.danger{color:var(--danger)}
//@
//@.info-banner{background:#e3f2fd;color:#1565c0;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:12px;line-height:1.5;border-left:3px solid #1565c0}
//@.warn-banner{background:#fff3e0;color:#e65100;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:12px;line-height:1.5;border-left:3px solid #e65100}
//@.err-banner{background:#ffebee;color:#c62828;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:12px;line-height:1.5;border-left:3px solid #c62828}
//@
//@::-webkit-scrollbar{width:6px;height:6px}
//@::-webkit-scrollbar-thumb{background:rgba(0,0,0,.18);border-radius:3px}
//@.term-box::-webkit-scrollbar-thumb,.code::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15)}
//@
//@.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .8s linear infinite;vertical-align:middle}
//@</style>
//@</head>
//@<body>
//@
//@<div id="app-view" class="view active">
//@  <div class="appbar">
//@    <button class="icon-btn" onclick="admin.openSidebar()"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg></button>
//@    <h1 id="page-title">Console TYN</h1>
//@    <div class="pill offline" id="status-pill" onclick="admin.refreshStatus()">
//@      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
//@      <span id="status-label">...</span>
//@    </div>
//@  </div>
//@  <div class="content" id="content">
//@
//@    <div class="page" data-page="dashboard">
//@      <div class="banner">
//@        <img src="banner.jpg" alt="banner" onerror="this.style.display='none'">
//@        <div class="banner-overlay"><div class="logo">TYN</div><div class="tag">TERMINAL Y NETWORK</div></div>
//@      </div>
//@
//@      <div class="card conn-card">
//@        <div class="conn-icon checking" id="conn-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
//@        <div class="conn-info">
//@          <div class="st" id="conn-st">Checking...</div>
//@          <div class="hint" id="conn-hint">Menghubungkan...</div>
//@        </div>
//@        <button class="btn" onclick="admin.testConnection()">Test</button>
//@      </div>
//@
//@      <div class="stat-grid">
//@        <div class="stat green"><div class="stat-label">Server</div><div class="stat-value" id="stat-server">—</div></div>
//@        <div class="stat"><div class="stat-label">Uptime</div><div class="stat-value" id="stat-uptime">—</div></div>
//@        <div class="stat gold"><div class="stat-label">Tokens</div><div class="stat-value" id="stat-tokens">—</div></div>
//@        <div class="stat"><div class="stat-label">Sessions</div><div class="stat-value" id="stat-sessions">—</div></div>
//@      </div>
//@
//@      <div class="card">
//@        <div class="card-title">Aktivasi Server <span class="badge" id="state-badge">—</span></div>
//@        <div class="input-group">
//@          <label>API Token</label>
//@          <input id="token-input" type="password" placeholder="tyn_xxxxxxxxxxxxxxxxxxxxx" autocomplete="off">
//@        </div>
//@        <div class="btn-row">
//@          <button class="btn success" style="flex:1" onclick="admin.enableServer()">▶ Enable</button>
//@          <button class="btn warning" style="flex:1" onclick="admin.disableServer()">⏸ Disable</button>
//@        </div>
//@      </div>
//@
//@      <div class="card">
//@        <div class="card-title">Quick Actions</div>
//@        <div class="btn-row">
//@          <button class="btn secondary" onclick="admin.showPage('apis')">🎫 Generate API</button>
//@          <button class="btn secondary" onclick="admin.showPage('terminal')">⌨ Terminal</button>
//@          <button class="btn secondary" onclick="window.open('/index.html','_blank')">📱 Buka App</button>
//@        </div>
//@      </div>
//@
//@      <div class="card">
//@        <div class="card-title">Bridge Info</div>
//@        <div id="bridge-info"><div class="empty"><p>Masukkan token untuk melihat info bridge</p></div></div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="server" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Server Control</div>
//@        <div class="info-banner">Kontrol status server bridge. Perubahan state berlaku langsung.</div>
//@        <div class="btn-row" style="margin-bottom:10px">
//@          <button class="btn success full" onclick="admin.enableServer()">▶ Enable Server</button>
//@        </div>
//@        <div class="btn-row" style="margin-bottom:10px">
//@          <button class="btn warning full" onclick="admin.disableServer()">⏸ Disable Server</button>
//@        </div>
//@        <div class="btn-row" style="margin-bottom:10px">
//@          <button class="btn secondary full" onclick="admin.restartServer()">↻ Restart Node</button>
//@        </div>
//@        <div class="btn-row">
//@          <button class="btn danger full" onclick="admin.killServer()">⛔ Full Shutdown</button>
//@        </div>
//@        <div class="warn-banner" style="margin-top:12px">
//@          <b>⚠ Catatan:</b> Full Shutdown akan mematikan node process. Untuk restart lagi, jalankan <code>bash tyn.sh</code> dari terminal.
//@        </div>
//@      </div>
//@
//@      <div class="card">
//@        <div class="card-title">Status Detail</div>
//@        <div id="server-status-detail"><div class="empty"><p>Loading...</p></div></div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="apis" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Generate API <span class="badge">1-day trial</span></div>
//@        <div class="info-banner">Generate token otomatis dengan masa aktif 1 hari.</div>
//@        <button class="btn full success" onclick="admin.generateApi()">🎫 Generate 1-Day Trial Token</button>
//@        <div id="gen-result" style="margin-top:12px"></div>
//@      </div>
//@
//@      <div class="card">
//@        <div class="card-title">API Tokens <span class="badge" id="api-count">0</span></div>
//@        <div id="apis-list"><div class="empty"><p>Loading...</p></div></div>
//@        <div class="btn-row" style="margin-top:10px">
//@          <button class="btn secondary" onclick="admin.loadApis()">↻ Refresh</button>
//@          <button class="btn warning" onclick="admin.cleanupApis()">🧹 Cleanup</button>
//@        </div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="terminal" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Terminal</div>
//@        <div class="info-banner">Eksekusi shell command lewat bridge. Koneksi persistent.</div>
//@        <div class="term-box" id="term-out">Menunggu koneksi...</div>
//@        <div class="term-input-row">
//@          <input id="term-cmd" placeholder="pkg install python" onkeypress="if(event.key==='Enter')admin.execCmd()">
//@          <button class="btn" onclick="admin.execCmd()">Run</button>
//@          <button class="btn secondary" onclick="document.getElementById('term-out').innerHTML='';">✕</button>
//@        </div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="sessions" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Active Sessions <span class="badge" id="sess-count">0</span></div>
//@        <div id="sessions-list"><div class="empty"><p>Loading...</p></div></div>
//@        <div class="btn-row" style="margin-top:10px">
//@          <button class="btn secondary" onclick="admin.loadSessions()">↻ Refresh</button>
//@          <button class="btn danger" onclick="admin.resetAllSessions()">Reset All</button>
//@        </div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="config" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Bridge Configuration</div>
//@        <div class="info-banner">Edit konfigurasi bridge (config.json). Perubahan butuh restart.</div>
//@        <div id="config-editor"><div class="empty"><p>Loading...</p></div></div>
//@        <div class="btn-row" style="margin-top:10px">
//@          <button class="btn secondary" onclick="admin.loadConfig()">↻ Reload</button>
//@          <button class="btn" onclick="admin.saveConfig()">💾 Save Config</button>
//@        </div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="modes" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Bridge Modes</div>
//@        <div class="info-banner">Pilih preset konfigurasi. Mode akan mengganti shell, term, dan fitur.</div>
//@        <div id="modes-list"></div>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="files" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Project Files</div>
//@        <div class="info-banner">Download file konfigurasi dari server.</div>
//@        <div id="files-list"><div class="empty"><p>Loading...</p></div></div>
//@      </div>
//@      <div class="card">
//@        <div class="card-title">Nano Files</div>
//@        <div id="nano-files-list"><div class="empty"><p>Loading...</p></div></div>
//@        <button class="btn secondary full" style="margin-top:10px" onclick="admin.loadNanoFiles()">↻ Refresh</button>
//@      </div>
//@    </div>
//@
//@    <div class="page" data-page="system" style="display:none">
//@      <div class="card">
//@        <div class="card-title">Health Check</div>
//@        <div id="health-list"><div class="empty"><p>Loading...</p></div></div>
//@        <button class="btn secondary full" style="margin-top:10px" onclick="admin.runHealth()">↻ Run Check</button>
//@      </div>
//@      <div class="card">
//@        <div class="card-title">System Info</div>
//@        <div id="system-info"><div class="empty"><p>Loading...</p></div></div>
//@      </div>
//@      <div class="card">
//@        <div class="card-title">Recent Logs</div>
//@        <div class="code" id="logs-box">Loading...</div>
//@        <button class="btn secondary full" style="margin-top:10px" onclick="admin.loadLogs()">↻ Refresh</button>
//@      </div>
//@    </div>
//@
//@  </div>
//@</div>
//@
//@<div class="sidebar-overlay" id="sidebar-overlay" onclick="admin.closeSidebar()"></div>
//@<div class="sidebar" id="sidebar">
//@  <div class="sidebar-banner">
//@    <img src="banner1.jpg" alt="banner1" onerror="this.src='banner.jpg';this.onerror=null">
//@    <div class="banner-overlay"><div class="logo">TYN</div><div class="tag">CONSOLE</div></div>
//@  </div>
//@  <div class="sidebar-items">
//@    <div class="sidebar-header">Main</div>
//@    <div class="sidebar-item active" data-page="dashboard" onclick="admin.showPage('dashboard')">
//@      <svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
//@      <span>Dashboard</span>
//@    </div>
//@    <div class="sidebar-item" data-page="server" onclick="admin.showPage('server')">
//@      <svg viewBox="0 0 24 24"><path d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
//@      <span>Server Control</span>
//@    </div>
//@    <div class="sidebar-item" data-page="apis" onclick="admin.showPage('apis')">
//@      <svg viewBox="0 0 24 24"><path d="M21 10h-8.35A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H13l2 2 2-2 2 2 4-4.04L21 10z"/></svg>
//@      <span>API Manager</span>
//@    </div>
//@    <div class="sidebar-item" data-page="terminal" onclick="admin.showPage('terminal')">
//@      <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM7 17l-5-5 1.4-1.4L7 14.2l8.6-8.6L17 7l-10 10z"/></svg>
//@      <span>Terminal</span>
//@    </div>
//@
//@    <div class="sidebar-divider"></div>
//@    <div class="sidebar-header">Manage</div>
//@    <div class="sidebar-item" data-page="sessions" onclick="admin.showPage('sessions')">
//@      <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
//@      <span>Sessions</span>
//@    </div>
//@    <div class="sidebar-item" data-page="config" onclick="admin.showPage('config')">
//@      <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
//@      <span>Config</span>
//@    </div>
//@    <div class="sidebar-item" data-page="modes" onclick="admin.showPage('modes')">
//@      <svg viewBox="0 0 24 24"><path d="M12 2l-5.5 9h11z"/><circle cx="17.5" cy="17.5" r="4.5"/><path d="M3 13.5h9v9H3z"/></svg>
//@      <span>Bridge Modes</span>
//@    </div>
//@    <div class="sidebar-item" data-page="files" onclick="admin.showPage('files')">
//@      <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
//@      <span>Files</span>
//@    </div>
//@    <div class="sidebar-item" data-page="system" onclick="admin.showPage('system')">
//@      <svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
//@      <span>System</span>
//@    </div>
//@
//@    <div class="sidebar-divider"></div>
//@    <div class="sidebar-item" onclick="window.open('/index.html','_blank')">
//@      <svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
//@      <span>Open Main App</span>
//@    </div>
//@  </div>
//@  <div class="sidebar-footer">Console TYN · v1.0.1-beta</div>
//@</div>
//@
//@<div class="modal-overlay" id="dialog-overlay">
//@  <div class="modal">
//@    <div class="modal-title" id="dialog-title">Konfirmasi</div>
//@    <div class="modal-body"><div id="dialog-message">Lanjutkan?</div></div>
//@    <div class="modal-actions">
//@      <button id="dialog-cancel">Batal</button>
//@      <button id="dialog-ok">OK</button>
//@    </div>
//@  </div>
//@</div>
//@
//@<div class="toast" id="toast"></div>
//@
//@<script>
//@const admin = {
//@  token: localStorage.getItem('tyn_admin_token') || '',
//@  ws: null,
//@  wsReady: false,
//@  wsQueue: [],
//@  cmdBuffer: '',
//@  cmdResolver: null,
//@  currentPage: 'dashboard',
//@  modeList: [
//@    { id: 'standard', label: 'Standard', desc: 'Semua fitur aktif (bash, webrun, flutter, nano, sessions)' },
//@    { id: 'flutter',  label: 'Flutter',  desc: 'Optimized untuk build APK (flutter on, webrun off)' },
//@    { id: 'python',   label: 'Python',   desc: 'Python dev focus (bash, webrun on)' },
//@    { id: 'webdev',   label: 'Web Dev',  desc: 'Web development (webrun on, flutter off)' },
//@    { id: 'minimal',  label: 'Minimal',  desc: 'Terminal only (xterm, no webrun/flutter)' },
//@    { id: 'power',    label: 'Power',    desc: 'Semua fitur maximal' },
//@    { id: 'lite',     label: 'Lite',     desc: 'Lightweight (sh shell, no extras)' }
//@  ],
//@
//@  init(){
//@    document.getElementById('token-input').value = this.token;
//@    this.testConnection(true);
//@    this.renderModes();
//@    setInterval(() => this.refreshStatus(true), 15000);
//@  },
//@
//@  baseUrl(){ return location.origin; },
//@  async api(path, opts={}){
//@    if (!this.token) throw new Error('Token belum diisi');
//@    const url = this.baseUrl() + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token);
//@    const headers = Object.assign({ 'X-API-Token': this.token }, opts.headers || {});
//@    if (opts.json){ headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); delete opts.json; }
//@    const res = await fetch(url, Object.assign({}, opts, { headers }));
//@    if (!res.ok) throw new Error('HTTP ' + res.status);
//@    return res.json();
//@  },
//@
//@  toast(msg, type){
//@    const t = document.getElementById('toast');
//@    t.textContent = msg;
//@    t.className = 'toast show ' + (type || '');
//@    clearTimeout(this._tt);
//@    this._tt = setTimeout(() => t.classList.remove('show'), 3000);
//@  },
//@  confirm(title, message, danger){
//@    return new Promise(resolve => {
//@      const ov = document.getElementById('dialog-overlay');
//@      document.getElementById('dialog-title').textContent = title;
//@      document.getElementById('dialog-message').textContent = message;
//@      const okBtn = document.getElementById('dialog-ok');
//@      okBtn.className = danger ? 'danger' : '';
//@      ov.classList.add('show');
//@      const done = r => { ov.classList.remove('show'); okBtn.onclick = null; document.getElementById('dialog-cancel').onclick = null; resolve(r); };
//@      okBtn.onclick = () => done(true);
//@      document.getElementById('dialog-cancel').onclick = () => done(false);
//@    });
//@  },
//@
//@  openSidebar(){ document.getElementById('sidebar').classList.add('show'); document.getElementById('sidebar-overlay').classList.add('show'); },
//@  closeSidebar(){ document.getElementById('sidebar').classList.remove('show'); document.getElementById('sidebar-overlay').classList.remove('show'); },
//@
//@  showPage(name){
//@    this.closeSidebar();
//@    this.currentPage = name;
//@    document.querySelectorAll('.page').forEach(p => p.style.display = p.getAttribute('data-page') === name ? '' : 'none');
//@    document.querySelectorAll('.sidebar-item[data-page]').forEach(el => el.classList.toggle('active', el.getAttribute('data-page') === name));
//@    const titles = { dashboard: 'Console TYN', server: 'Server Control', apis: 'API Manager', terminal: 'Terminal', sessions: 'Sessions', config: 'Config', modes: 'Bridge Modes', files: 'Files', system: 'System' };
//@    document.getElementById('page-title').textContent = titles[name] || 'Console TYN';
//@    document.getElementById('content').scrollTop = 0;
//@    if (name === 'apis') this.loadApis();
//@    if (name === 'sessions') this.loadSessions();
//@    if (name === 'config') this.loadConfig();
//@    if (name === 'files') { this.loadFiles(); this.loadNanoFiles(); }
//@    if (name === 'system') { this.runHealth(); this.loadSystemInfo(); this.loadLogs(); }
//@    if (name === 'terminal') this.connectWS();
//@    if (name === 'modes') this.renderModes();
//@    if (name === 'server') this.loadServerDetail();
//@  },
//@
//@  saveToken(){
//@    this.token = document.getElementById('token-input').value.trim();
//@    localStorage.setItem('tyn_admin_token', this.token);
//@    this.toast('Token disimpan', 'success');
//@    if (this.ws){ try { this.ws.close(); } catch(_){} this.ws = null; this.wsReady = false; }
//@    this.testConnection();
//@  },
//@
//@  async testConnection(silent){
//@    const icon = document.getElementById('conn-icon');
//@    const st = document.getElementById('conn-st');
//@    const hint = document.getElementById('conn-hint');
//@    if (!silent){ icon.className = 'conn-icon checking'; st.textContent = 'Checking...'; hint.textContent = 'Menghubungkan...'; }
//@    let ok = false, data = null, err = '';
//@    try {
//@      const res = await fetch(this.baseUrl() + '/check?token=' + encodeURIComponent(this.token), {
//@        headers: { 'X-API-Token': this.token }
//@      });
//@      if (res.ok){ data = await res.json(); ok = true; }
//@      else err = 'HTTP ' + res.status;
//@    } catch(e){ err = e.message; }
//@    if (ok){
//@      icon.className = 'conn-icon online';
//@      st.textContent = 'Terhubung';
//@      hint.textContent = 'Bridge v' + data.version + ' · ' + data.execMode + ' · uptime ' + this.fmtTime(data.uptime);
//@      document.getElementById('bridge-info').innerHTML = '<div class="code">' + this.esc(JSON.stringify(data, null, 2)) + '</div>';
//@      document.getElementById('status-pill').className = 'pill online';
//@      document.getElementById('status-label').textContent = 'ONLINE';
//@      document.getElementById('state-badge').textContent = data.apiExpiresInHuman || 'active';
//@    } else {
//@      icon.className = 'conn-icon offline';
//@      st.textContent = 'Tidak terhubung';
//@      hint.textContent = err || 'Token salah / server offline';
//@      document.getElementById('status-pill').className = 'pill offline';
//@      document.getElementById('status-label').textContent = 'OFFLINE';
//@    }
//@    if (!silent) this.toast(ok ? 'Terhubung ✓' : 'Gagal: ' + err, ok ? 'success' : 'error');
//@    this.refreshStatus(true);
//@  },
//@
//@  async refreshStatus(silent){
//@    try {
//@      const res = await fetch(this.baseUrl() + '/api/state');
//@      const d = await res.json();
//@      document.getElementById('stat-server').textContent = (d.state || '?').toUpperCase();
//@      document.getElementById('stat-server').className = 'stat-value ' + (d.state === 'on' ? 'green' : 'red');
//@      document.getElementById('stat-tokens').textContent = d.validTokenCount || 0;
//@      document.getElementById('stat-sessions').textContent = d.shells || 0;
//@      document.getElementById('state-badge').textContent = (d.state || '?').toUpperCase();
//@      if (d.state === 'on'){
//@        document.getElementById('status-pill').className = 'pill online';
//@        document.getElementById('status-label').textContent = 'SERVER ON';
//@      } else {
//@        document.getElementById('status-pill').className = 'pill offline';
//@        document.getElementById('status-label').textContent = 'SERVER OFF';
//@      }
//@      if (this.token){
//@        try {
//@          const cres = await fetch(this.baseUrl() + '/check?token=' + encodeURIComponent(this.token), { headers: { 'X-API-Token': this.token } });
//@          if (cres.ok){ const cd = await cres.json(); document.getElementById('stat-uptime').textContent = this.fmtTime(cd.uptime); }
//@        } catch(_){}
//@      }
//@    } catch(_){}
//@  },
//@
//@  fmtTime(sec){
//@    sec = Math.floor(sec || 0);
//@    if (sec < 60) return sec + 's';
//@    if (sec < 3600) return Math.floor(sec/60) + 'm';
//@    if (sec < 86400) return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
//@    return Math.floor(sec/86400) + 'd ' + Math.floor((sec%86400)/3600) + 'h';
//@  },
//@
//@  connectWS(){
//@    return new Promise((resolve, reject) => {
//@      if (this.ws && this.ws.readyState === 1){ this.wsReady = true; return resolve(); }
//@      if (!this.token) return reject(new Error('Token kosong'));
//@      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
//@      try {
//@        this.ws = new WebSocket(proto + '://' + location.host + '/term?token=' + encodeURIComponent(this.token) + '&session=admin_console');
//@        const self = this;
//@        this.ws.onopen = () => { self.wsReady = true; self.appendTerm('[connected]\n', 't-ok'); resolve(); };
//@        this.ws.onmessage = ev => {
//@          let msg = null;
//@          try { msg = JSON.parse(ev.data); } catch(_){}
//@          const txt = msg && msg.type === 'out' ? msg.data : ev.data;
//@          if (msg && msg.type === 'error'){ self.appendTerm('[ERR] ' + msg.data + '\n', 't-err'); return; }
//@          if (msg && msg.type === 'yn-prompt'){ self.appendTerm('\n[prompt] ' + msg.question + ' → jawab otomatis y\n', 't-warn'); self.sendRaw('y\n'); return; }
//@          self.cmdBuffer += txt;
//@          if (self.cmdResolver) self.cmdResolver(txt);
//@        };
//@        this.ws.onclose = () => { self.wsReady = false; self.appendTerm('\n[disconnected]\n', 't-warn'); };
//@        this.ws.onerror = () => { self.wsReady = false; reject(new Error('WS error')); };
//@        setTimeout(() => { if (!self.wsReady) reject(new Error('WS timeout')); }, 5000);
//@      } catch(e){ reject(e); }
//@    });
//@  },
//@
//@  sendRaw(data){
//@    if (this.ws && this.ws.readyState === 1){ this.ws.send(JSON.stringify({ type: 'input', data })); return true; }
//@    return false;
//@  },
//@
//@  async exec(cmd, opts={}){
//@    await this.connectWS().catch(() => {});
//@    if (!this.wsReady) throw new Error('WebSocket belum terhubung');
//@    const id = 'TYN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
//@    const marker = '[[END_' + id + ']]';
//@    const fullCmd = '( ' + cmd + ' ) 2>&1; echo "' + marker + '"';
//@    return new Promise((resolve, reject) => {
//@      let buffer = '';
//@      const timeout = setTimeout(() => { this.cmdResolver = null; reject(new Error('Command timeout')); }, opts.timeout || 30000);
//@      this.cmdResolver = chunk => {
//@        buffer += chunk;
//@        if (buffer.includes(marker)){
//@          clearTimeout(timeout);
//@          this.cmdResolver = null;
//@          const clean = buffer.split(marker)[0];
//@          resolve(clean);
//@        }
//@      };
//@      this.ws.send(JSON.stringify({ type: 'input', data: fullCmd + '\n' }));
//@    });
//@  },
//@
//@  appendTerm(txt, cls){
//@    const box = document.getElementById('term-out');
//@    if (!box) return;
//@    const clean = String(txt).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
//@    const span = document.createElement('span');
//@    if (cls) span.className = cls;
//@    span.textContent = clean;
//@    box.appendChild(span);
//@    box.scrollTop = box.scrollHeight;
//@  },
//@
//@  async execCmd(){
//@    const inp = document.getElementById('term-cmd');
//@    const cmd = inp.value.trim();
//@    if (!cmd) return;
//@    inp.value = '';
//@    this.appendTerm('$ ' + cmd + '\n', 't-cmd');
//@    try {
//@      await this.connectWS();
//@      this.ws.send(JSON.stringify({ type: 'exec', cmd }));
//@    } catch(e){ this.appendTerm('[error] ' + e.message + '\n', 't-err'); }
//@  },
//@
//@  async enableServer(){
//@    this.token = document.getElementById('token-input').value.trim() || this.token;
//@    if (!this.token){ this.toast('Masukkan token dulu', 'error'); return; }
//@    localStorage.setItem('tyn_admin_token', this.token);
//@    try {
//@      await this.connectWS();
//@      await this.exec('echo on > server.state && echo OK');
//@      this.toast('Server enabled ✓', 'success');
//@      this.refreshStatus();
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@  async disableServer(){
//@    try {
//@      await this.connectWS();
//@      await this.exec('echo off > server.state && echo OK');
//@      this.toast('Server disabled', 'warning');
//@      this.refreshStatus();
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@  async restartServer(){
//@    const ok = await this.confirm('Restart Server', 'Restart node process? Session akan terputus sebentar.');
//@    if (!ok) return;
//@    try {
//@      await this.connectWS();
//@      const pid = await this.exec('cat .server.pid 2>/dev/null');
//@      if (pid.trim()){
//@        await this.exec("nohup bash -c 'sleep 2 && kill " + pid.trim() + " && sleep 1 && nohup node bridge.js >> bridge.log 2>&1 &' > /dev/null 2>&1 &");
//@        this.toast('Restarting...', 'warning');
//@        setTimeout(() => { this.testConnection(); }, 5000);
//@      } else this.toast('PID tidak ditemukan', 'error');
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@  async killServer(){
//@    const ok = await this.confirm('Full Shutdown', 'Kill node process? Server tidak bisa diakses sampai anda jalankan tyn.sh lagi.', true);
//@    if (!ok) return;
//@    try {
//@      await this.connectWS();
//@      const pid = await this.exec('cat .server.pid 2>/dev/null');
//@      if (pid.trim()){
//@        await this.exec("nohup bash -c 'sleep 2 && kill -9 " + pid.trim() + "' > /dev/null 2>&1 &");
//@        this.toast('Server shutting down...', 'warning');
//@        setTimeout(() => { this.wsReady = false; this.testConnection(); }, 4000);
//@      } else this.toast('PID tidak ditemukan', 'error');
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@
//@  async loadServerDetail(){
//@    const box = document.getElementById('server-status-detail');
//@    try {
//@      const d = await this.exec('cat server.state 2>/dev/null; echo "---"; cat .server.pid 2>/dev/null; echo "---"; ps aux 2>/dev/null | grep -v grep | grep bridge.js | head -1');
//@      const parts = d.split('---').map(s => s.trim());
//@      const state = parts[0] || 'off';
//@      const pid = parts[1] || 'n/a';
//@      const proc = parts[2] || 'not running';
//@      box.innerHTML = '<table><tr><td>State</td><td class="mono ' + (state === 'on' ? 'ok' : 'err') + '">' + state.toUpperCase() + '</td></tr><tr><td>PID</td><td class="mono">' + (pid || '—') + '</td></tr><tr><td>Process</td><td class="mono muted" style="font-size:10px">' + (this.esc(proc.slice(0,80)) || '—') + '</td></tr></table>';
//@    } catch(e){ box.innerHTML = '<div class="err-banner">' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async loadApis(){
//@    const box = document.getElementById('apis-list');
//@    box.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
//@    try {
//@      const out = await this.exec('cat apis.json 2>/dev/null');
//@      const match = out.match(/\{[\s\S]*\}/);
//@      if (!match) throw new Error('No JSON');
//@      const d = JSON.parse(match[0]);
//@      const apis = d.apis || [];
//@      const now = Date.now();
//@      document.getElementById('api-count').textContent = apis.length;
//@      if (!apis.length){ box.innerHTML = '<div class="empty"><p>Belum ada token</p></div>'; return; }
//@      let html = '<table><thead><tr><th>#</th><th>Token</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>';
//@      apis.forEach((a, i) => {
//@        let st = 'active', cls = 'ok';
//@        if (a.revoked){ st = 'revoked'; cls = 'err'; }
//@        else if (a.expiresAt && now > a.expiresAt){ st = 'expired'; cls = 'warn'; }
//@        let exp = 'never';
//@        if (a.expiresAt){
//@          const rem = a.expiresAt - now;
//@          if (rem > 0) exp = this.fmtTime(rem/1000);
//@          else exp = 'expired';
//@        }
//@        const tok = (a.token || '').slice(0, 20) + '...';
//@        html += '<tr><td class="mono">' + (i+1) + '</td><td class="mono">' + this.esc(tok) + '</td><td class="' + cls + '">' + st + '</td><td class="muted">' + exp + '</td><td><button class="btn danger" style="padding:5px 10px;font-size:10px" onclick="admin.revokeApi(' + i + ')">Revoke</button></td></tr>';
//@      });
//@      html += '</tbody></table>';
//@      box.innerHTML = html;
//@    } catch(e){ box.innerHTML = '<div class="err-banner">' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async generateApi(){
//@    const box = document.getElementById('gen-result');
//@    box.innerHTML = '<div class="info-banner">⏳ Generating token...</div>';
//@    try {
//@      const script = "node -e 'const fs=require(\"fs\");try{const d=JSON.parse(fs.readFileSync(\"apis.json\",\"utf8\"));const t=\"tyn_\"+require(\"crypto\").randomBytes(20).toString(\"hex\");const n=Date.now();d.apis=d.apis||[];d.apis.push({token:t,label:\"Trial 1 day\",duration:\"1 day\",createdAt:n,expiresAt:n+86400000,revoked:false});fs.writeFileSync(\"apis.json\",JSON.stringify(d,null,2));process.stdout.write(\"TOKEN:\"+t);}catch(e){process.stdout.write(\"ERR:\"+e.message);}'";
//@      const out = await this.exec(script);
//@      const m = out.match(/TOKEN:(tyn_[a-f0-9]{40})/);
//@      if (!m) throw new Error('No token in output: ' + out.slice(0, 100));
//@      const token = m[1];
//@      box.innerHTML = '<div class="info-banner" style="background:#e8f5e9;color:#2e7d32;border-left-color:#2e7d32"><b>✓ API Generated (1-day trial)</b></div><div class="input-group"><label>Token</label><input value="' + this.esc(token) + '" readonly onclick="this.select()"></div><div class="btn-row"><button class="btn" style="flex:1" onclick="navigator.clipboard.writeText(\'' + this.esc(token) + '\');admin.toast(\'Token copied\',\'success\')">📋 Copy</button><button class="btn success" style="flex:1" onclick="document.getElementById(\'token-input\').value=\'' + this.esc(token) + '\';document.getElementById(\'token-input\').dispatchEvent(new Event(\'input\'))">✓ Use</button></div>';
//@      this.toast('Token berhasil dibuat', 'success');
//@      this.loadApis();
//@    } catch(e){ box.innerHTML = '<div class="err-banner">Gagal: ' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async revokeApi(idx){
//@    const ok = await this.confirm('Revoke Token', 'Token akan di-revoke permanen?', true);
//@    if (!ok) return;
//@    try {
//@      const script = "node -e 'const fs=require(\"fs\");const d=JSON.parse(fs.readFileSync(\"apis.json\",\"utf8\"));if(d.apis[" + idx + "]){d.apis[" + idx + "].revoked=true;fs.writeFileSync(\"apis.json\",JSON.stringify(d,null,2));process.stdout.write(\"OK\");}else{process.stdout.write(\"ERR:not found\");}'";
//@      const out = await this.exec(script);
//@      if (out.includes('OK')){ this.toast('Revoked', 'success'); this.loadApis(); }
//@      else this.toast('Gagal', 'error');
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@
//@  async cleanupApis(){
//@    const ok = await this.confirm('Cleanup Tokens', 'Hapus semua token expired/revoked?');
//@    if (!ok) return;
//@    try {
//@      const script = "node -e 'const fs=require(\"fs\");const d=JSON.parse(fs.readFileSync(\"apis.json\",\"utf8\"));const now=Date.now();const before=(d.apis||[]).length;d.apis=(d.apis||[]).filter(a=>!a.revoked&&(!a.expiresAt||a.expiresAt>now));fs.writeFileSync(\"apis.json\",JSON.stringify(d,null,2));process.stdout.write(\"OK:\"+(before-d.apis.length));'";
//@      const out = await this.exec(script);
//@      this.toast('Cleanup: ' + ((out.match(/OK:(\d+)/)||[])[1] || '?') + ' removed', 'success');
//@      this.loadApis();
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@
//@  async loadSessions(){
//@    const box = document.getElementById('sessions-list');
//@    box.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
//@    try {
//@      const d = await this.api('/api/sessions');
//@      const list = d.sessions || [];
//@      document.getElementById('sess-count').textContent = list.length;
//@      if (!list.length){ box.innerHTML = '<div class="empty"><p>Tidak ada session aktif</p></div>'; return; }
//@      let html = '<table><thead><tr><th>ID</th><th>Mode</th><th>Clients</th><th>Idle</th><th></th></tr></thead><tbody>';
//@      list.forEach(s => {
//@        html += '<tr><td class="mono">' + this.esc(s.id.slice(0, 20)) + '</td><td>' + this.esc(s.mode || '?') + '</td><td>' + (s.clients || 0) + '</td><td class="muted">' + this.fmtTime(s.idleFor / 1000) + '</td><td><button class="btn danger" style="padding:5px 10px;font-size:10px" onclick="admin.resetSession(\'' + this.esc(s.id) + '\')">Reset</button></td></tr>';
//@      });
//@      html += '</tbody></table>';
//@      box.innerHTML = html;
//@    } catch(e){ box.innerHTML = '<div class="err-banner">' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async resetSession(id){
//@    try {
//@      await this.api('/api/sessions/' + encodeURIComponent(id) + '/reset', { method: 'POST' });
//@      this.toast('Session reset', 'success');
//@      this.loadSessions();
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@  async resetAllSessions(){
//@    const ok = await this.confirm('Reset All', 'Reset semua session aktif?', true);
//@    if (!ok) return;
//@    try {
//@      const d = await this.api('/api/sessions');
//@      for (const s of (d.sessions || [])){
//@        await this.api('/api/sessions/' + encodeURIComponent(s.id) + '/reset', { method: 'POST' });
//@      }
//@      this.toast('All reset', 'success');
//@      this.loadSessions();
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@
//@  async loadConfig(){
//@    const box = document.getElementById('config-editor');
//@    box.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
//@    try {
//@      const out = await this.exec('cat config.json 2>/dev/null');
//@      const match = out.match(/\{[\s\S]*\}/);
//@      if (!match) throw new Error('No JSON');
//@      const d = JSON.parse(match[0]);
//@      let html = '';
//@      const flat = (obj, prefix='') => {
//@        for (const k of Object.keys(obj)){
//@          const key = prefix ? prefix + '.' + k : k;
//@          const v = obj[k];
//@          if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key);
//@          else {
//@            const val = typeof v === 'string' ? v : JSON.stringify(v);
//@            html += '<div class="input-group"><label>' + this.esc(key) + '</label><input data-key="' + this.esc(key) + '" value="' + this.esc(val) + '"></div>';
//@          }
//@        }
//@      };
//@      flat(d);
//@      box.innerHTML = html;
//@    } catch(e){ box.innerHTML = '<div class="err-banner">' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async saveConfig(){
//@    const inputs = document.querySelectorAll('#config-editor input[data-key]');
//@    const patch = {};
//@    inputs.forEach(inp => {
//@      const key = inp.getAttribute('data-key');
//@      let val = inp.value;
//@      if (/^\d+$/.test(val)) val = +val;
//@      else if (val === 'true' || val === 'false') val = val === 'true';
//@      patch[key] = val;
//@    });
//@    try {
//@      const jsObj = JSON.stringify(patch).replace(/"/g, '\\"');
//@      const script = "node -e 'const fs=require(\"fs\");const patch=JSON.parse(\"" + jsObj + "\");const d=JSON.parse(fs.readFileSync(\"config.json\",\"utf8\"));for(const path in patch){const parts=path.split(\".\");let cur=d;for(let i=0;i<parts.length-1;i++){if(!cur[parts[i]]||typeof cur[parts[i]]!==\"object\")cur[parts[i]]={};cur=cur[parts[i]];}cur[parts[parts.length-1]]=patch[path];}fs.writeFileSync(\"config.json\",JSON.stringify(d,null,2));process.stdout.write(\"OK\");'";
//@      const out = await this.exec(script);
//@      if (out.includes('OK')){ this.toast('Config saved. Restart untuk apply.', 'success'); }
//@      else this.toast('Gagal save', 'error');
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@
//@  renderModes(){
//@    const box = document.getElementById('modes-list');
//@    let html = '';
//@    this.modeList.forEach(m => {
//@      html += '<div class="card" style="margin-bottom:8px;padding:12px"><div style="display:flex;justify-content:space-between;align-items:center"><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:#212121">' + m.label + '</div><div style="font-size:11px;color:#757575;margin-top:2px">' + m.desc + '</div></div><button class="btn" style="padding:7px 12px;font-size:11px" onclick="admin.applyMode(\'' + m.id + '\')">Apply</button></div></div>';
//@    });
//@    box.innerHTML = html;
//@  },
//@
//@  async applyMode(mode){
//@    const presets = {
//@      standard: { shell: 'bash', termType: 'xterm-256color', features: { webrun: true, flutter: true, nano: true, sessions: true } },
//@      flutter:  { shell: 'bash', termType: 'xterm-256color', features: { webrun: false, flutter: true, nano: true, sessions: true } },
//@      python:   { shell: 'bash', termType: 'xterm-256color', features: { webrun: true, flutter: false, nano: true, sessions: true } },
//@      webdev:   { shell: 'bash', termType: 'xterm-256color', features: { webrun: true, flutter: false, nano: true, sessions: true } },
//@      minimal:  { shell: 'bash', termType: 'xterm',          features: { webrun: false, flutter: false, nano: true, sessions: false } },
//@      power:    { shell: 'bash', termType: 'xterm-256color', features: { webrun: true, flutter: true, nano: true, sessions: true } },
//@      lite:     { shell: 'sh',   termType: 'xterm',          features: { webrun: false, flutter: false, nano: false, sessions: false } }
//@    };
//@    const p = presets[mode];
//@    if (!p) return;
//@    const ok = await this.confirm('Apply Mode', 'Set mode ke "' + mode + '"?');
//@    if (!ok) return;
//@    try {
//@      const patchJson = JSON.stringify({ mode, shell: p.shell, termType: p.termType, features: p.features }).replace(/"/g, '\\"');
//@      const script = "node -e 'const fs=require(\"fs\");const patch=JSON.parse(\"" + patchJson + "\");const d=JSON.parse(fs.readFileSync(\"config.json\",\"utf8\"));Object.assign(d,patch);fs.writeFileSync(\"config.json\",JSON.stringify(d,null,2));process.stdout.write(\"OK\");'";
//@      const out = await this.exec(script);
//@      if (out.includes('OK')){ this.toast('Mode → ' + mode + ' (restart untuk apply)', 'success'); }
//@      else this.toast('Gagal apply', 'error');
//@    } catch(e){ this.toast('Error: ' + e.message, 'error'); }
//@  },
//@
//@  async loadFiles(){
//@    const box = document.getElementById('files-list');
//@    const files = ['apis.json', 'config.json', 'server.state', 'bridge.log'];
//@    let html = '<table><thead><tr><th>File</th><th>Size</th><th></th></tr></thead><tbody>';
//@    for (const f of files){
//@      try {
//@        const out = await this.exec('ls -la ' + f + " 2>/dev/null | awk '{print $5}'");
//@        const size = (out.trim() || '').split('\n')[0].trim();
//@        const sz = size && /^\d+$/.test(size) ? this.fmtBytes(+size) : '—';
//@        html += '<tr><td class="mono">' + f + '</td><td class="muted">' + sz + '</td><td><button class="btn secondary" style="padding:5px 10px;font-size:10px" onclick="admin.downloadFile(\'' + f + '\')">⬇ Download</button></td></tr>';
//@      } catch(_){}
//@    }
//@    html += '</tbody></table>';
//@    box.innerHTML = html;
//@  },
//@
//@  async downloadFile(name){
//@    try {
//@      const content = await this.exec('cat ' + name + ' 2>/dev/null');
//@      const clean = ['apis.json','config.json'].includes(name) ? content.trim() : content;
//@      const mime = ['apis.json','config.json'].includes(name) ? 'application/json' : 'text/plain';
//@      const blob = new Blob([clean], { type: mime });
//@      const url = URL.createObjectURL(blob);
//@      const a = document.createElement('a');
//@      a.href = url; a.download = name;
//@      document.body.appendChild(a); a.click(); document.body.removeChild(a);
//@      setTimeout(() => URL.revokeObjectURL(url), 1000);
//@      this.toast('Downloaded: ' + name, 'success');
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@
//@  async loadNanoFiles(){
//@    const box = document.getElementById('nano-files-list');
//@    try {
//@      const d = await this.api('/api/nano/files');
//@      const files = d.files || [];
//@      if (!files.length){ box.innerHTML = '<div class="empty"><p>Belum ada file nano</p></div>'; return; }
//@      let html = '<table><thead><tr><th>Name</th><th>Size</th><th></th></tr></thead><tbody>';
//@      files.forEach(f => {
//@        html += '<tr><td class="mono">' + this.esc(f.name) + '</td><td class="muted">' + this.fmtBytes(f.size) + '</td><td><button class="btn secondary" style="padding:5px 10px;font-size:10px" onclick="admin.viewNano(\'' + this.esc(f.name).replace(/\'/g, "\\'") + '\')">View</button></td></tr>';
//@      });
//@      html += '</tbody></table>';
//@      box.innerHTML = html;
//@    } catch(e){ box.innerHTML = '<div class="empty"><p>' + this.esc(e.message) + '</p></div>'; }
//@  },
//@
//@  async viewNano(name){
//@    try {
//@      const d = await this.api('/api/nano/get/' + encodeURIComponent(name));
//@      const w = window.open('', '_blank');
//@      w.document.write('<pre style="font-family:monospace;font-size:13px;padding:20px;background:#0a0a0a;color:#e0e0e0;min-height:100vh;margin:0;white-space:pre-wrap">' + this.esc(d.content) + '</pre>');
//@    } catch(e){ this.toast('Gagal: ' + e.message, 'error'); }
//@  },
//@
//@  async runHealth(){
//@    const box = document.getElementById('health-list');
//@    box.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
//@    const checks = [];
//@    try {
//@      const state = await this.exec('cat server.state 2>/dev/null');
//@      checks.push({ label: 'Server state', ok: state.trim() === 'on', value: state.trim().toUpperCase() });
//@    } catch(e){ checks.push({ label: 'Server state', ok: false, value: 'err' }); }
//@    try {
//@      const pid = await this.exec('cat .server.pid 2>/dev/null');
//@      checks.push({ label: 'PID file', ok: !!pid.trim(), value: pid.trim() || 'missing' });
//@    } catch(e){ checks.push({ label: 'PID file', ok: false, value: 'err' }); }
//@    try {
//@      const apis = await this.exec('cat apis.json 2>/dev/null');
//@      const m = apis.match(/\{[\s\S]*\}/);
//@      if (m){
//@        const d = JSON.parse(m[0]);
//@        const now = Date.now();
//@        const valid = (d.apis || []).filter(a => !a.revoked && (!a.expiresAt || a.expiresAt > now)).length;
//@        checks.push({ label: 'Valid tokens', ok: valid > 0, value: valid + ' valid' });
//@      } else checks.push({ label: 'apis.json', ok: false, value: 'invalid' });
//@    } catch(e){ checks.push({ label: 'apis.json', ok: false, value: 'err' }); }
//@    try {
//@      const cfg = await this.exec('cat config.json 2>/dev/null');
//@      checks.push({ label: 'config.json', ok: !!cfg.trim(), value: cfg.trim() ? 'exists' : 'missing' });
//@    } catch(e){ checks.push({ label: 'config.json', ok: false, value: 'err' }); }
//@    try {
//@      const node = await this.exec('command -v node >/dev/null 2>&1 && node -v');
//@      checks.push({ label: 'Node.js', ok: !!node.trim(), value: node.trim() || 'missing' });
//@    } catch(e){ checks.push({ label: 'Node.js', ok: false, value: 'err' }); }
//@    let html = '<table><tbody>';
//@    checks.forEach(c => {
//@      html += '<tr><td>' + (c.ok ? '<span style="color:#2e7d32;font-weight:700">✓</span>' : '<span style="color:#c62828;font-weight:700">✗</span>') + ' ' + this.esc(c.label) + '</td><td class="mono ' + (c.ok ? 'ok' : 'err') + '">' + this.esc(c.value) + '</td></tr>';
//@    });
//@    html += '</tbody></table>';
//@    box.innerHTML = html;
//@  },
//@
//@  async loadSystemInfo(){
//@    const box = document.getElementById('system-info');
//@    try {
//@      const out = await this.exec('uname -a; echo "---"; node -v 2>/dev/null; echo "---"; npm -v 2>/dev/null; echo "---"; pwd; echo "---"; ls -la 2>/dev/null | head -20');
//@      const parts = out.split('---');
//@      let html = '<table><tbody>';
//@      html += '<tr><td>OS</td><td class="mono muted" style="font-size:10px">' + this.esc((parts[0]||'').trim().slice(0,80)) + '</td></tr>';
//@      html += '<tr><td>Node</td><td class="mono">' + this.esc((parts[1]||'').trim()) + '</td></tr>';
//@      html += '<tr><td>NPM</td><td class="mono">' + this.esc((parts[2]||'').trim()) + '</td></tr>';
//@      html += '<tr><td>CWD</td><td class="mono">' + this.esc((parts[3]||'').trim()) + '</td></tr>';
//@      html += '</tbody></table>';
//@      const files = (parts[4] || '').trim().split('\n').filter(Boolean).slice(0, 10).map(l => {
//@        const cols = l.split(/\s+/);
//@        return '<tr><td class="mono">' + this.esc(cols[cols.length-1] || '') + '</td><td class="muted">' + (cols[4] || '') + '</td></tr>';
//@      }).join('');
//@      if (files){ html += '<div class="card-title" style="margin-top:14px">Files</div><table><tbody>' + files + '</tbody></table>'; }
//@      box.innerHTML = html;
//@    } catch(e){ box.innerHTML = '<div class="err-banner">' + this.esc(e.message) + '</div>'; }
//@  },
//@
//@  async loadLogs(){
//@    const box = document.getElementById('logs-box');
//@    try {
//@      const out = await this.exec('tail -n 50 bridge.log 2>/dev/null');
//@      box.textContent = out.trim() || '(kosong)';
//@    } catch(e){ box.textContent = 'Error: ' + e.message; }
//@  },
//@
//@  fmtBytes(b){
//@    if (b < 1024) return b + ' B';
//@    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
//@    if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
//@    return (b/1073741824).toFixed(2) + ' GB';
//@  },
//@  esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
//@};
//@
//@document.getElementById('token-input').addEventListener('change', () => admin.saveToken());
//@admin.init();
//@</script>
//@</body>
//@</html>