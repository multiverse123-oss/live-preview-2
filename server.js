const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false
}));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const NPM_CACHE = path.join(__dirname, 'npm-cache');
fs.mkdirSync(NPM_CACHE, { recursive: true });

const projects = new Map();
const sessions = new Map();

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

const BINARY_EXTS = ['.png','.jpg','.jpeg','.gif','.webp','.mp4','.webm','.ogg','.woff','.woff2','.ttf','.eot','.ico','.svg','.pdf'];

function isBinaryExtension(fp) {
  return BINARY_EXTS.includes(path.extname(fp).toLowerCase());
}

function writeFileSmart(fp, content) {
  if (isBinaryExtension(fp)) {
    fs.writeFileSync(fp, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(fp, content, 'utf8');
  }
}

const FRONTEND_DIRS = ['frontend', 'client', 'web', 'src'];

function detectFrontendRoot(baseDir) {
  const rootPkg = path.join(baseDir, 'package.json');
  if (fs.existsSync(rootPkg)) {
    for (const dir of FRONTEND_DIRS) {
      const subDir = path.join(baseDir, dir);
      if (fs.existsSync(path.join(subDir, 'package.json'))) {
        return subDir;
      }
    }
    return baseDir;
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = path.join(baseDir, entry.name);
      if (fs.existsSync(path.join(subDir, 'package.json'))) {
        for (const dir of FRONTEND_DIRS) {
          const innerFront = path.join(subDir, dir);
          if (fs.existsSync(path.join(innerFront, 'package.json'))) {
            return innerFront;
          }
        }
        return subDir;
      }
    }
  }
  return baseDir;
}

app.post('/api/projects', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object')
    return res.status(400).json({ error: 'Missing files object' });
  const id = uuidv4();
  projects.set(id, { files, createdAt: Date.now() });
  res.json({ id });
});

// ─── Safe config patcher – no regex, uses string replacement precisely ───
function patchViteConfig(content, id) {
  // Remove any existing base and server block (just in case)
  content = content.replace(/^\s*base\s*:\s*(["'].*?["'])\s*,?\s*$/gm, '');
  content = content.replace(/^\s*server\s*:\s*\{[^}]*\},?\s*$/gm, '');
  
  // Now inject base and server inside defineConfig({ ... })
  // Look for 'defineConfig(' and then the opening brace
  const defineIndex = content.indexOf('defineConfig(');
  if (defineIndex === -1) return content;   // not a valid Vite config

  const openBrace = content.indexOf('{', defineIndex);
  if (openBrace === -1) return content;

  // Insert right after the opening brace, before the first existing property
  const before = content.slice(0, openBrace + 1);
  const after = content.slice(openBrace + 1);
  
  // Build the new config fragment
  const newConfig = `
  base: '/preview/${id}/',
  server: { allowedHosts: true, host: '0.0.0.0' },`;
  
  return before + newConfig + after;
}

function waitForServerReady(port, id, timeoutMs = 1000000) {   // 1000 seconds
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('Health check timeout'));
      http.get(`http://127.0.0.1:${port}/preview/${id}/`, (res) => {
        if (res.statusCode === 200 && (res.headers['content-type'] || '').includes('text/html')) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      }).on('error', () => setTimeout(check, 500));
    };
    check();
  });
}

function startDevServer(id) {
  const project = projects.get(id);
  if (!project) return;
  const existing = sessions.get(id);
  if (existing && existing.status === 'running') return;

  const session = { status: 'starting', logs: [], port: null, process: null, outputDir: null, lastUsed: Date.now() };
  sessions.set(id, session);

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const viteKey = Object.keys(project.files).find(f => f === 'vite.config.js' || f === 'vite.config.ts');
  if (viteKey) {
    project.files[viteKey] = patchViteConfig(project.files[viteKey], id);
  }

  Object.entries(project.files).forEach(([f, c]) => {
    const fp = path.join(tmpDir, f);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSmart(fp, c);
  });

  const log = (line) => {
    const s = sessions.get(id);
    if (s) s.logs.push(line);
  };

  const frontendRoot = detectFrontendRoot(tmpDir);
  const relPath = path.relative(tmpDir, frontendRoot) || '.';
  log(`Frontend root: ${relPath}`);

  if (!fs.existsSync(path.join(frontendRoot, 'package.json'))) {
    log('No package.json – serving static files instantly');
    session.status = 'running';
    session.outputDir = frontendRoot;
    log('✅ Static preview ready');
    return;
  }

  log('Installing dependencies...');
  const env = { ...process.env, NODE_ENV: 'development', npm_config_cache: NPM_CACHE };
  const install = spawn('npm', ['install', '--prefer-offline'], { cwd: frontendRoot, env, shell: true });

  install.stdout.on('data', d => log(d.toString()));
  install.stderr.on('data', d => log(d.toString()));

  install.on('error', (err) => {
    log(`Install error: ${err.message}`);
    session.status = 'error';
  });

  install.on('close', (code) => {
    if (code !== 0) {
      log(`npm install failed with code ${code}`);
      session.status = 'error';
      return;
    }
    log('Install complete – starting dev server...');

    const pkgPath = path.join(frontendRoot, 'package.json');
    let startCmd = ['npm', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '0', '--base', `/preview/${id}/`];
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.scripts?.dev) {
        startCmd = ['npx', 'serve', '.', '-l', '0'];
      }
    }

    const dev = spawn(startCmd[0], startCmd.slice(1), { cwd: frontendRoot, env, shell: true });
    session.process = dev;

    let portResolved = false;
    dev.stdout.on('data', (data) => {
      const str = data.toString();
      log(str);
      if (!portResolved) {
        const match = str.match(/http:\/\/localhost:(\d+)/);
        if (match) {
          const port = parseInt(match[1], 10);
          portResolved = true;
          waitForServerReady(port, id)
            .then(() => {
              session.port = port;
              session.status = 'running';
              log(`✅ Dev server healthy on port ${port}`);
            })
            .catch(err => {
              session.status = 'error';
              log(`❌ Dev server health check failed: ${err.message}`);
            });
        }
      }
    });
    dev.stderr.on('data', d => log(d.toString()));
    dev.on('error', (err) => {
      log(`Dev server error: ${err.message}`);
      session.status = 'error';
    });
    dev.on('close', () => {
      if (!portResolved || session.status !== 'running') session.status = 'error';
      else session.status = 'stopped';
    });
  });
}

setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, id) => {
    if (s.status === 'running' && s.process && now - s.lastUsed > 10 * 60 * 1000) {
      s.process.kill();
      sessions.delete(id);
      projects.delete(id);
      fs.rmSync(path.join(__dirname, 'builds', id), { recursive: true, force: true });
    }
  });
}, 5 * 60 * 1000);

app.get('/api/projects/:id/preview', (req, res) => {
  const id = req.params.id;
  if (!projects.has(id)) return res.status(404).json({ error: 'Project not found' });
  const s = sessions.get(id);
  if (s?.status === 'running') {
    s.lastUsed = Date.now();
    return res.json({ url: `/preview/${id}`, status: 'ready' });
  }
  startDevServer(id);
  res.json({ url: `/preview/${id}`, status: 'starting' });
});

app.get('/api/projects/:id/logs', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: s.logs, status: s.status, url: `/preview/${req.params.id}` });
});

app.use('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const session = sessions.get(id);

  if (session && session.status === 'running' && !session.port && session.outputDir) {
    return express.static(session.outputDir)(req, res, next);
  }

  if (session && session.status === 'running' && session.port) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: session.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${session.port}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).send('Preview server unreachable'));
    return req.pipe(proxyReq);
  }

  next();
});

app.get('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (session?.status === 'running') return next();
  if (projects.has(id)) {
    if (!session || session.status !== 'starting') startDevServer(id);
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Loading...</title>
<style>body{margin:0;background:#ffffff;color:#111;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}.spinner{width:48px;height:48px;border:5px solid #e5e7eb;border-top:5px solid #3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:16px}@keyframes spin{to{transform:rotate(360deg)}}h2{margin-bottom:8px;font-weight:600}p{color:#6b7280}</style>
<script>const id='${id}';setInterval(async()=>{try{const r=await fetch('/api/projects/'+id+'/logs');const d=await r.json();if(d.status==='running')window.location.reload()}catch(e){}},1500)</script>
</head><body><div class="spinner"></div><h2>Setting up your preview…</h2><p>This will only take a few seconds</p></body></html>`);
  }
  next();
});

const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Engine running on port ' + PORT));
