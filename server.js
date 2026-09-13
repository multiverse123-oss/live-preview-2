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

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

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

function findMatchingBrace(content, openBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBrace; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function patchViteConfig(content, id) {
  if (typeof content !== 'string') {
    throw new Error('Vite config must be text');
  }

  const defineIndex = content.indexOf('defineConfig(');
  if (defineIndex === -1) {
    return content;
  }

  const openBrace = content.indexOf('{', defineIndex);
  if (openBrace === -1) {
    return content;
  }

  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace === -1) {
    throw new Error('Could not find the end of the Vite config object');
  }

  const injectedConfig = [
    '',
    `  base: '/preview/${id}/',`,
    `  server: { allowedHosts: true, host: '0.0.0.0' },`,
    ''
  ].join('\n');

  // Insert at the end of the config object so existing base/server fields
  // cannot override the proxy-safe values. This intentionally uses indexes,
  // not a regex that could corrupt nested JavaScript.
  return content.slice(0, closeBrace) + injectedConfig + content.slice(closeBrace);
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

      const detected = detectFrontendRoot(tmpDir);
      if (!detected) {
        throw new Error('Root package.json uses concurrently, but no frontend Vite directory was found');
      }
      const frontendRoot = detected.directory;
      session.outputDir = frontendRoot;
      logLine(session, `Frontend root: ${path.relative(tmpDir, frontendRoot) || '.'} (${detected.reason})`);

      const viteConfig = readViteConfig(frontendRoot);
      if (viteConfig) {
        const original = fs.readFileSync(viteConfig.filePath, 'utf8');
        fs.writeFileSync(viteConfig.filePath, patchViteConfig(original, id), 'utf8');
        logLine(session, `Patched ${viteConfig.fileName} with proxy-safe base and host settings`);
      }

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

  if (session.port) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: session.port,
      path: previewPath(id, req.originalUrl),
      method: req.method,
      headers: { ...req.headers, host: `localhost:${session.port}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
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