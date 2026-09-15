const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NPM_CACHE = path.join(__dirname, 'npm-cache');
const BUILDS_DIR = path.join(__dirname, 'builds');
const projects = new Map();
const sessions = new Map();
const FRONTEND_DIRS = ['frontend', 'client', 'web', 'src'];
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm',
  '.woff', '.woff2', '.ttf', '.ico', '.svg', '.pdf'
]);
const HEALTH_CHECK_TIMEOUT_MS = 1000 * 1000;
const AI_STUDIO_IMPORTS = {
  react: 'https://esm.sh/react@18',
  'react-dom': 'https://esm.sh/react-dom@18',
  'react-dom/client': 'https://esm.sh/react-dom@18/client',
  'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime',
  'react-router-dom': 'https://esm.sh/react-router-dom@6',
  'react-router-dom/': 'https://esm.sh/react-router-dom@6/'
};

const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

fs.mkdirSync(NPM_CACHE, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

function timestamp() {
  return new Date().toISOString();
}

function logLine(session, message) {
  if (!session) return;
  const text = String(message);
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (line.length > 0) {
      session.logs.push(`[${timestamp()}] ${line}`);
    }
  }
}

function logServer(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function isBinaryExtension(filePath) {
  return BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}

function writeFileSmart(filePath, content) {
  if (typeof content !== 'string') {
    throw new Error(`File content must be a string: ${filePath}`);
  }
  if (isBinaryExtension(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function resolveProjectFile(baseDir, fileName) {
  if (typeof fileName !== 'string' || fileName.includes('\0')) {
    throw new Error('Invalid project file path');
  }

  const normalizedName = fileName.replace(/\\/g, '/');
  const resolved = path.resolve(baseDir, normalizedName);
  const relative = path.relative(baseDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Project file escapes its build directory: ${fileName}`);
  }
  return resolved;
}

function hasViteConfig(directory) {
  return fs.existsSync(path.join(directory, 'vite.config.js')) ||
    fs.existsSync(path.join(directory, 'vite.config.ts'));
}

function readPackage(directory) {
  const packagePath = path.join(directory, 'package.json');
  if (!fs.existsSync(packagePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid package.json in ${directory}: ${error.message}`);
  }
}

function hasAnyPackageJson(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'package.json') return true;
    if (entry.isDirectory() && hasAnyPackageJson(entryPath)) return true;
  }
  return false;
}

function listProjectFiles(directory, extensions = null, result = []) {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      listProjectFiles(entryPath, extensions, result);
      continue;
    }
    if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) {
      result.push(entryPath);
    }
  }
  return result;
}

function isAiStudioProject(directory) {
  return !hasAnyPackageJson(directory) &&
    listProjectFiles(directory, new Set(['.ts', '.tsx'])).length > 0;
}

function aiStudioSourceFiles(directory) {
  return listProjectFiles(directory, new Set(['.ts', '.tsx']));
}

function isConcurrentlyScript(script) {
  return typeof script === 'string' && script.toLowerCase().includes('concurrently');
}

function detectFrontendRoot(baseDir) {
  if (hasViteConfig(baseDir)) {
    return { directory: baseDir, reason: 'root Vite config' };
  }

  for (const name of FRONTEND_DIRS) {
    const directory = path.join(baseDir, name);
    if (fs.existsSync(directory) && hasViteConfig(directory)) {
      return { directory, reason: `${name}/ Vite config` };
    }
  }

  const immediateDirectories = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of immediateDirectories) {
    const directory = path.join(baseDir, entry.name);
    if (hasViteConfig(directory)) {
      return { directory, reason: `immediate ${entry.name}/ Vite config` };
    }
  }

  for (const name of FRONTEND_DIRS) {
    const directory = path.join(baseDir, name);
    if (readPackage(directory)) {
      return { directory, reason: `${name}/ package.json` };
    }
  }

  const rootPackage = readPackage(baseDir);
  if (rootPackage) {
    if (isConcurrentlyScript(rootPackage.scripts?.dev)) {
      return null;
    }
    return { directory: baseDir, reason: 'root package.json' };
  }

  if (!hasAnyPackageJson(baseDir)) {
    return { directory: baseDir, reason: 'static project with no package.json' };
  }

  for (const entry of immediateDirectories) {
    const directory = path.join(baseDir, entry.name);
    if (readPackage(directory)) {
      return { directory, reason: `immediate ${entry.name}/ package.json` };
    }
  }

  return { directory: baseDir, reason: 'project root fallback' };
}

function readViteConfig(directory) {
  for (const fileName of ['vite.config.js', 'vite.config.ts']) {
    const filePath = path.join(directory, fileName);
    if (fs.existsSync(filePath)) {
      return { fileName, filePath };
    }
  }
  return null;
}

function isViteProject(directory, packageJson) {
  if (readViteConfig(directory)) return true;
  const scripts = packageJson?.scripts || {};
  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {})
  };
  return Boolean(dependencies.vite) || /\bvite\b/i.test(scripts.dev || '');
}

function loadEsbuild() {
  const candidates = [
    'esbuild',
    path.join(__dirname, 'client', 'node_modules', 'esbuild')
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next location. The client install owns the transitive Vite dependency.
    }
  }
  throw new Error('AI Studio runtime requires esbuild; run the engine build first');
}

function normalizeProjectPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function existingAiFile(baseDir, requestPath, extensions = []) {
  const cleanPath = decodeURIComponent(String(requestPath || '').split('?')[0])
    .replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('\0')) return null;

  const candidates = [cleanPath];
  if (!path.extname(cleanPath)) {
    candidates.push(...extensions.map((extension) => `${cleanPath}${extension}`));
    candidates.push(...extensions.map((extension) => path.join(cleanPath, `index${extension}`)));
  }

  for (const candidate of candidates) {
    try {
      const filePath = resolveProjectFile(baseDir, candidate);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return {
          filePath,
          relativePath: normalizeProjectPath(path.relative(baseDir, filePath))
        };
      }
    } catch {
      // Invalid or escaping candidates are simply not project files.
    }
  }
  return null;
}

function resolveAiImport(baseDir, currentFile, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;

  const [specifierPath, query = ''] = specifier.split('?', 2);
  const currentDirectory = path.dirname(currentFile);
  const requested = normalizeProjectPath(path.normalize(path.join(currentDirectory, specifierPath)));
  const candidates = [requested];
  if (!path.extname(requested)) {
    candidates.push(`${requested}.tsx`, `${requested}.ts`, `${requested}.jsx`, `${requested}.js`);
    candidates.push(
      `${requested}/index.tsx`,
      `${requested}/index.ts`,
      `${requested}/index.jsx`,
      `${requested}/index.js`,
      `${requested}.css`
    );
  }

  for (const candidate of candidates) {
    try {
      const filePath = resolveProjectFile(baseDir, candidate);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const relativePath = normalizeProjectPath(path.relative(baseDir, filePath));
      const extension = path.extname(filePath).toLowerCase();
      const modulePath = normalizeProjectPath(path.relative(currentDirectory, relativePath));
      const browserPath = modulePath.startsWith('.') ? modulePath : `./${modulePath}`;
      if (extension === '.css') {
        return `${browserPath}?__ai_css=1`;
      }
      return query ? `${browserPath}?${query}` : browserPath;
    } catch {
      // Leave unresolved imports untouched so the browser can report the original module.
    }
  }
  return specifier;
}

function rewriteAiImports(code, baseDir, currentFile) {
  const importPattern = /(\b(?:from\s*|import\s*(?:\(\s*)?))(['"])(\.{1,2}\/[^'"]+)\2/g;
  return code.replace(importPattern, (match, prefix, quote, specifier) => {
    const resolved = resolveAiImport(baseDir, currentFile, specifier);
    return `${prefix}${quote}${resolved}${quote}`;
  });
}

async function transpileAiModule(baseDir, filePath) {
  const esbuild = loadEsbuild();
  const source = fs.readFileSync(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  const loader = extension === '.ts' ? 'ts' : 'tsx';
  const result = await esbuild.transform(source, {
    loader,
    format: 'esm',
    target: 'es2020',
    sourcemap: 'inline',
    sourcefile: normalizeProjectPath(path.relative(baseDir, filePath))
  });
  return rewriteAiImports(
    result.code,
    baseDir,
    normalizeProjectPath(path.relative(baseDir, filePath))
  );
}

function aiCssModule(source) {
  return `const css = ${JSON.stringify(source)};
const style = document.createElement('style');
style.setAttribute('data-ai-studio-css', 'true');
style.textContent = css;
document.head.appendChild(style);
export default {};
`;
}

function aiStudioBody(baseDir) {
  const indexPath = path.join(baseDir, 'index.html');
  if (!fs.existsSync(indexPath)) return '<div id="root"></div>';
  const source = fs.readFileSync(indexPath, 'utf8');
  const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : source;
  const withoutModuleEntries = body.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+\.(?:tsx?|jsx?)["'][^>]*><\/script>/gi,
    ''
  );
  return withoutModuleEntries.trim() || '<div id="root"></div>';
}

function aiStudioEntry(baseDir) {
  let metadata = {};
  const metadataPath = path.join(baseDir, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      metadata = {};
    }
  }

  const candidates = [
    typeof metadata.entry === 'string' ? metadata.entry : null,
    'index.tsx',
    'index.ts',
    'App.tsx',
    'App.ts'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = existingAiFile(baseDir, candidate, ['.tsx', '.ts']);
    if (file) return file.relativePath;
  }
  return candidates[0] || 'index.tsx';
}

function aiStudioShell(id, baseDir) {
  const prefix = `/preview/${id}/`;
  const importMap = JSON.stringify({ imports: AI_STUDIO_IMPORTS }, null, 2);
  const body = aiStudioBody(baseDir).replace(/<\/script/gi, '<\\/script');
  const errorHandler = `
<script>
(() => {
  const showError = (error) => {
    const root = document.getElementById('root') || document.body;
    const message = error && error.stack
      ? error.stack
      : String(error && error.message ? error.message : error);
    console.error('AI Studio preview failed', error);
    root.replaceChildren();

    const panel = document.createElement('div');
    panel.style.cssText = 'padding:24px;font-family:system-ui,sans-serif;color:#334155';
    const heading = document.createElement('h2');
    heading.textContent = 'AI Studio preview failed';
    const details = document.createElement('pre');
    details.style.cssText = 'white-space:pre-wrap;color:#b91c1c';
    details.textContent = message;
    panel.append(heading, details);
    root.appendChild(panel);
  };

  window.__showAiStudioError = showError;
  window.addEventListener('error', (event) => showError(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => showError(event.reason));
})();
</script>`;
  const loader = `
<script type="module">
const previewBase = ${JSON.stringify(prefix)};
const defaultEntry = ${JSON.stringify(aiStudioEntry(baseDir))};
const normalizeEntry = (value) => {
  if (typeof value !== 'string') return defaultEntry;
  const candidate = value.trim().replace(/^\\/+/, '');
  if (!candidate || candidate.split('/').includes('..') || candidate.includes('\\0')) {
    return defaultEntry;
  }
  return candidate;
};

async function readEntry() {
  try {
    const response = await fetch(previewBase + 'metadata.json', { cache: 'no-store' });
    if (!response.ok) return defaultEntry;
    const metadata = await response.json();
    return normalizeEntry(metadata.entry);
  } catch {
    return defaultEntry;
  }
}

async function importEntry(entry) {
  const candidates = [entry, 'index.tsx', 'index.ts', 'App.tsx', 'App.ts']
    .filter((value, index, values) => value && values.indexOf(value) === index);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await import(new URL(candidate, window.location.href).href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No AI Studio entry module found');
}

async function start() {
  const root = document.getElementById('root') || document.body;
  try {
    const module = await importEntry(await readEntry());
    if (
      root.id === 'root' &&
      root.children.length === 0 &&
      !root.textContent.trim() &&
      typeof module.default === 'function'
    ) {
      const React = await import('react');
      const ReactDOM = await import('react-dom/client');
      ReactDOM.createRoot(root).render(React.createElement(module.default));
    }
    document.documentElement.dataset.aiStudioReady = 'true';
  } catch (error) {
    console.error('AI Studio preview module failed', error);
    if (typeof window.__showAiStudioError === 'function') {
      window.__showAiStudioError(error);
    } else {
      root.textContent = String(error && error.stack ? error.stack : error);
    }
  }
}

start();
</script>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Studio Preview</title>
  <script type="importmap">${importMap}</script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>${body}${errorHandler}${loader}</body>
</html>`;
}

async function serveAiStudioRequest(id, session, req, res, next) {
  const baseDir = session.outputDir;
  const prefix = `/preview/${id}`;
  const requested = req.originalUrl.split('?')[0].slice(prefix.length).replace(/^\/+/, '');

  if (!requested || requested === 'index.html') {
    res.type('html').send(aiStudioShell(id, baseDir));
    return;
  }

  const url = new URL(req.originalUrl, 'http://preview.local');
  const aiFile = existingAiFile(baseDir, requested, ['.tsx', '.ts']);
  if (!aiFile) {
    if (req.method === 'GET') res.status(404).send('AI Studio project file not found');
    else next();
    return;
  }

  try {
    const extension = path.extname(aiFile.filePath).toLowerCase();
    if ((extension === '.ts' || extension === '.tsx') && req.method === 'GET') {
      const code = await transpileAiModule(baseDir, aiFile.filePath);
      res.type('application/javascript').send(code);
      return;
    }
    if (extension === '.css' && url.searchParams.get('__ai_css') === '1') {
      res.type('application/javascript').send(
        aiCssModule(fs.readFileSync(aiFile.filePath, 'utf8'))
      );
      return;
    }
    if (req.method === 'GET') {
      res.sendFile(aiFile.filePath);
      return;
    }
    next();
  } catch (error) {
    logLine(session, `AI Studio transform failed for ${aiFile.relativePath}: ${error.message}`);
    res.status(500).type('text').send('AI Studio module could not be transformed');
  }
}

function sanitizePreviewHeaders(headers) {
  const sanitized = { ...headers };
  for (const header of [
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy'
  ]) {
    delete sanitized[header];
  }
  return sanitized;
}

function detectPort(output) {
  const matches = [
    output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i),
    output.match(/\bport\s+(\d{2,5})\b/i)
  ];
  for (const match of matches) {
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function requestHealth(port, requestPath) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      timeout: 5000,
      headers: { Host: `localhost:${port}` }
    }, (response) => {
      const contentType = response.headers['content-type'] || '';
      const healthy = response.statusCode >= 200 &&
        response.statusCode < 400 &&
        contentType.includes('text/html');
      response.resume();
      resolve(healthy);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForServerReady(port, id, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  const paths = [`/preview/${id}/`, '/'];
  while (Date.now() - startedAt <= timeoutMs) {
    for (const requestPath of paths) {
      if (await requestHealth(port, requestPath)) return requestPath;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Health check timeout after ${timeoutMs / 1000} seconds`);
}

function setSessionError(session, error) {
  const message = error instanceof Error ? error.message : String(error);
  logLine(session, `ERROR: ${message}`);
  session.status = 'error';
}

function spawnCommand(session, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false
  });
  session.process = child;
  logLine(session, `Spawned ${command} ${args.join(' ')}`);
  return child;
}

function startDevServer(id) {
  const project = projects.get(id);
  if (!project) return null;

  const existing = sessions.get(id);
  if (existing && (existing.status === 'starting' || existing.status === 'running')) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const session = {
    status: 'starting',
    logs: [],
    port: null,
    process: null,
    installProcess: null,
    outputDir: null,
    runtime: null,
    lastUsed: Date.now()
  };
  sessions.set(id, session);
  logLine(session, 'Preview setup started');

  setImmediate(() => {
    try {
      const tmpDir = path.join(BUILDS_DIR, id);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      for (const [fileName, content] of Object.entries(project.files)) {
        const filePath = resolveProjectFile(tmpDir, fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSmart(filePath, content);
      }
      logLine(session, `Wrote ${Object.keys(project.files).length} project files`);

      if (isAiStudioProject(tmpDir)) {
        const sourceFiles = aiStudioSourceFiles(tmpDir);
        session.outputDir = tmpDir;
        session.runtime = 'ai-studio';
        logLine(session, 'AI Studio project detected (no package.json, contains TSX/TS)');
        logLine(session, `Transpiling ${sourceFiles.length} TS/TSX files on demand`);
        logLine(session, 'Serving runtime HTML shell');
        logLine(session, `Entry: ${aiStudioEntry(tmpDir)}`);
        session.status = 'running';
        logLine(session, '✅ Dev server ready (AI Studio runtime)');
        return;
      }

      const detected = detectFrontendRoot(tmpDir);
      if (!detected) {
        throw new Error('Root package.json uses concurrently, but no frontend Vite directory was found');
      }
      const frontendRoot = detected.directory;
      session.outputDir = frontendRoot;
      logLine(session, `Frontend root: ${path.relative(tmpDir, frontendRoot) || '.'} (${detected.reason})`);

      const packageJson = readPackage(frontendRoot);
      if (!packageJson) {
        logLine(session, 'No package.json found anywhere; serving static files immediately');
        session.status = 'running';
        logLine(session, 'Static preview ready');
        return;
      }

      logLine(session, 'Starting npm install');
      const env = {
        ...process.env,
        NODE_ENV: 'development',
        npm_config_cache: NPM_CACHE
      };
      const install = spawnCommand(session, 'npm', [
        'install', '--prefer-offline', '--no-audit', '--no-fund'
      ], { cwd: frontendRoot, env });
      session.installProcess = install;

      const handleInstallOutput = (data) => logLine(session, data.toString());
      install.stdout.on('data', handleInstallOutput);
      install.stderr.on('data', handleInstallOutput);
      install.on('error', (error) => setSessionError(session, `npm install failed to start: ${error.message}`));
      install.on('close', (code) => {
        session.installProcess = null;
        if (session.status === 'error') return;
        if (code !== 0) {
          setSessionError(session, `npm install failed with code ${code}`);
          return;
        }

        logLine(session, 'Install complete');
        const viteProject = isViteProject(frontendRoot, packageJson);
        let command;
        let args;
        if (viteProject) {
          command = 'npx';
          args = [
            'vite',
            '--host', '0.0.0.0',
            '--port', '0',
            '--base', `/preview/${id}/`
          ];
          logLine(session, 'Vite frontend detected; root backend scripts are ignored');
        } else if (packageJson.scripts?.dev && !isConcurrentlyScript(packageJson.scripts.dev)) {
          command = 'npm';
          args = ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '0'];
        } else {
          setSessionError(session, 'No safe frontend dev command found');
          return;
        }

        logLine(session, `Starting frontend dev server: ${command} ${args.join(' ')}`);
        const dev = spawnCommand(session, command, args, { cwd: frontendRoot, env });
        let portResolved = false;
        let healthStarted = false;

        const handleDevOutput = (data) => {
          const output = data.toString();
          logLine(session, output);
          if (portResolved) return;
          const port = detectPort(output);
          if (!port) return;
          portResolved = true;
          session.port = port;
          logLine(session, `Detected frontend port ${port}`);
          if (healthStarted) return;
          healthStarted = true;
          waitForServerReady(port, id)
            .then((healthyPath) => {
              session.status = 'running';
              session.lastUsed = Date.now();
              logLine(session, `Health check passed at ${healthyPath}`);
              logLine(session, `Preview running on port ${port}`);
            })
            .catch((error) => setSessionError(session, `Health check failed: ${error.message}`));
        };

        dev.stdout.on('data', handleDevOutput);
        dev.stderr.on('data', handleDevOutput);
        dev.on('error', (error) => setSessionError(session, `Dev server failed to start: ${error.message}`));
        dev.on('close', (code, signal) => {
          logLine(session, `Dev server exited with code ${code}${signal ? ` (${signal})` : ''}`);
          if (session.status === 'starting') {
            setSessionError(session, 'Dev server exited before becoming healthy');
          } else if (session.status === 'running') {
            session.status = 'stopped';
          }
        });
      });
    } catch (error) {
      setSessionError(session, error);
    }
  });

  return session;
}

function previewPath(id, originalUrl) {
  const prefix = `/preview/${id}`;
  if (!originalUrl.startsWith(prefix)) return originalUrl || '/';
  const suffix = originalUrl.slice(prefix.length);
  if (!suffix) return `${prefix}/`;
  if (suffix.startsWith('?')) return `${prefix}/${suffix}`;
  return originalUrl;
}

app.post('/api/projects', (req, res) => {
  const { files } = req.body || {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.status(400).json({ error: 'Missing files object' });
  }
  if (Object.keys(files).length === 0) {
    return res.status(400).json({ error: 'Files object cannot be empty' });
  }

  try {
    for (const [fileName, content] of Object.entries(files)) {
      if (!fileName || typeof content !== 'string') {
        throw new Error(`Invalid file entry: ${fileName}`);
      }
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const id = uuidv4();
  projects.set(id, { files: { ...files }, createdAt: Date.now() });
  return res.status(201).json({ id });
});

app.get('/api/projects/:id/preview', (req, res) => {
  const { id } = req.params;
  if (!projects.has(id)) return res.status(404).json({ error: 'Project not found' });
  const session = startDevServer(id);
  if (session.status === 'running') {
    session.lastUsed = Date.now();
    return res.json({ url: `/preview/${id}/`, status: 'ready' });
  }
  return res.status(202).json({ url: `/preview/${id}/`, status: session.status });
});

app.get('/api/projects/:id/logs', (req, res) => {
  const { id } = req.params;
  if (!projects.has(id)) return res.status(404).json({ error: 'Project not found' });
  const session = sessions.get(id);
  return res.json({
    logs: session?.logs || [],
    status: session?.status || 'idle',
    url: `/preview/${id}/`
  });
});

app.use('/preview/:id', (req, res, next) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (!session || session.status !== 'running') return next();
  session.lastUsed = Date.now();

  if (session.runtime === 'ai-studio') {
    serveAiStudioRequest(id, session, req, res, next).catch((error) => {
      logLine(session, `AI Studio request failed: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).type('text').send('AI Studio preview request failed');
      }
    });
    return;
  }

  if (session.port) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: session.port,
      path: previewPath(id, req.originalUrl),
      method: req.method,
      headers: { ...req.headers, host: `localhost:${session.port}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, sanitizePreviewHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    });
    proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('Preview proxy timeout')));
    proxyReq.on('error', (error) => {
      if (!res.headersSent) res.status(502).send(`Preview server unreachable: ${error.message}`);
      else res.end();
    });
    req.pipe(proxyReq);
    return;
  }

  const staticHandler = express.static(session.outputDir, { index: 'index.html' });
  staticHandler(req, res, () => {
    if (req.method === 'GET' && !res.headersSent) {
      const indexPath = path.join(session.outputDir, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    }
    return next();
  });
});

app.get('/preview/:id', (req, res, next) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (session?.status === 'running') return next();
  if (!projects.has(id)) return res.status(404).send('Preview not found');

  if (!session || session.status === 'stopped' || session.status === 'error') {
    startDevServer(id);
  }
  return res.send(`<!doctype html>
<html><head><meta charset="UTF-8"><title>Loading preview</title>
<style>body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}.spinner{width:48px;height:48px;border:5px solid #e5e7eb;border-top:5px solid #3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}@keyframes spin{to{transform:rotate(360deg)}}h2{margin:0 0 8px;font-weight:600}p{color:#6b7280}</style>
<script>const id=${JSON.stringify(id)};setInterval(async()=>{try{const response=await fetch('/api/projects/'+id+'/logs');const data=await response.json();if(data.status==='running')window.location.reload();if(data.status==='error')document.body.innerHTML='<h2>Preview failed</h2><p>Check the build logs for details.</p>'}catch(e){}},1500)</script>
</head><body><div class="spinner"></div><h2>Setting up your preview…</h2><p>Build progress is available in the logs.</p></body></html>`);
});

const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('*', (req, res) => res.status(404).send('Preview engine client has not been built'));
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.status === 'running' && now - session.lastUsed > 10 * 60 * 1000) {
      if (session.process) session.process.kill();
      if (session.installProcess) session.installProcess.kill();
      sessions.delete(id);
      projects.delete(id);
      fs.rmSync(path.join(BUILDS_DIR, id), { recursive: true, force: true });
      logServer(`Cleaned up inactive preview ${id}`);
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.listen(PORT, () => logServer(`Engine running on port ${PORT}`));