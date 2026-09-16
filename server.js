const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const sandboxLib = require('./lib/sandboxLib');
const { runAgentTurn } = require('./lib/agent');
const accounts = require('./lib/accounts');

const app = express();
const PORT = process.env.PORT || 4173;
const NOVITA_BASE = 'https://api.novita.ai';

// Belt-and-suspenders: a single unhandled rejection anywhere (a stray async
// call in a WS handler, a background .then() with no .catch()) otherwise
// crashes this entire process — every open sandbox connection, every
// account, everyone's session — for a failure that should have stayed
// local to whatever one request triggered it. Log it and keep running.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (ignored, server stays up):', err);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Two ways a request can carry credentials:
//  - x-novita-key: a raw key typed into Settings, kept in the browser only.
//  - x-novita-account: the id of a key saved server-side via the Accounts tab
//    (data/accounts.json, gitignored) so switching between multiple Novita
//    accounts doesn't require retyping keys each run.
function resolveApiKey(req, res) {
  const accountId = req.header('x-novita-account');
  if (accountId) {
    try {
      return accounts.getApiKey(accountId);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return null;
    }
  }
  const apiKey = req.header('x-novita-key');
  if (!apiKey) {
    res.status(400).json({ error: 'No API key set. Add or select an account, or set a key in Settings.' });
    return null;
  }
  return apiKey;
}

function handle(fn) {
  return async (req, res) => {
    const apiKey = resolveApiKey(req, res);
    if (!apiKey) return;
    try {
      res.json(await fn(apiKey, req));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  };
}

/* ---- Saved accounts (multiple Novita accounts, switchable without retyping keys) ---- */
app.get('/api/accounts', (req, res) => {
  res.json({ accounts: accounts.listAccounts() });
});
app.post('/api/accounts', (req, res) => {
  try {
    res.json(accounts.addAccount(req.body.label, req.body.apiKey));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/accounts/:id', (req, res) => {
  try {
    res.json(accounts.removeAccount(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/* ---- Sandboxes (novita-sandbox SDK, not a plain REST proxy) ---- */
app.get('/api/sandbox/list', handle((apiKey, req) => {
  const state = req.query.state ? String(req.query.state).split(',') : undefined;
  return sandboxLib.listSandboxes(apiKey, { state });
}));
app.post('/api/sandbox/create', handle((apiKey, req) => sandboxLib.createSandbox(apiKey, req.body)));
app.get('/api/sandbox/:id', handle((apiKey, req) => sandboxLib.getSandbox(apiKey, req.params.id)));
app.post('/api/sandbox/:id/rename', handle((apiKey, req) => sandboxLib.renameSandbox(apiKey, req.params.id, req.body.name)));
app.post('/api/sandbox/:id/kill', handle((apiKey, req) => sandboxLib.killSandbox(apiKey, req.params.id)));
app.post('/api/sandbox/:id/pause', handle((apiKey, req) => sandboxLib.pauseSandbox(apiKey, req.params.id)));
app.post('/api/sandbox/:id/resume', handle((apiKey, req) => sandboxLib.resumeSandbox(apiKey, req.params.id)));
app.post('/api/sandbox/:id/setup-claude-code', handle((apiKey, req) => sandboxLib.setupClaudeCodeDevEnv(apiKey, req.params.id, req.body)));
app.get('/api/sandbox/:id/metrics', handle((apiKey, req) => sandboxLib.getSandboxMetrics(apiKey, req.params.id)));
app.post('/api/sandbox/:id/mount-volume', handle((apiKey, req) => sandboxLib.mountVolume(apiKey, req.params.id, req.body.volumeName, req.body.mountPath)));
app.post('/api/sandbox/:id/unmount-volume', handle((apiKey, req) => sandboxLib.unmountVolume(apiKey, req.params.id, req.body.mountPath)));
app.get('/api/sandbox/:id/ssh-command', handle((apiKey, req) => sandboxLib.getSshConnectionCommand(apiKey, req.params.id)));
app.post('/api/sandbox/:id/enable-ssh', handle((apiKey, req) => sandboxLib.enableSshAccess(apiKey, req.params.id, req.body)));

// Sandbox templates are a different namespace from the GPU-instance templates
// the /api/proxy route reaches, so they need their own SDK-backed endpoint.
app.get('/api/sandbox-templates', handle((apiKey) => sandboxLib.listSandboxTemplates(apiKey)));

/* ---- Persistent Volumes (survive independently of any one sandbox) ---- */
app.get('/api/volume/list', handle((apiKey) => sandboxLib.listVolumes(apiKey)));
app.post('/api/volume/create', handle((apiKey, req) => sandboxLib.createVolume(apiKey, req.body.name, req.body.quotaSizeGiB)));
app.delete('/api/volume/:id', handle((apiKey, req) => sandboxLib.deleteVolume(apiKey, req.params.id)));

// Browsers can't set custom headers on a WebSocket handshake, so the API key
// can't travel with the upgrade request the way it does on normal fetches.
// Instead the page first asks for a one-time ticket over a normal
// (header-authenticated) POST, then opens the socket with just that ticket
// in the URL. Tickets are single-use and expire in 30s if never claimed.
const terminalTickets = new Map();
app.post('/api/sandbox/:id/terminal-ticket', handle(async (apiKey, req) => {
  const sandboxId = await sandboxLib.resolveSandboxId(apiKey, req.params.id);
  const ticket = crypto.randomUUID();
  terminalTickets.set(ticket, { apiKey, sandboxId, expires: Date.now() + 30000 });
  return { ticket };
}));

/* ---- AI Agent (Novita chat completions + sandbox tool calling) ---- */
app.post('/api/agent/chat', handle(async (apiKey, req) => {
  const { model, messages } = req.body;
  if (!Array.isArray(messages)) throw new Error('messages must be an array.');
  return runAgentTurn(apiKey, model, messages);
}));

// Generic proxy: the browser never talks to api.novita.ai directly (no CORS
// there), and the API key never touches disk — it's sent per-request from
// the page and forwarded straight through.
app.all('/api/proxy/*', async (req, res) => {
  const apiKey = resolveApiKey(req, res);
  if (!apiKey) return;

  const upstreamPath = req.params[0];
  const queryIndex = req.originalUrl.indexOf('?');
  const queryString = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  const url = `${NOVITA_BASE}/${upstreamPath}${queryString}`;

  const init = {
    method: req.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (!['GET', 'HEAD'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    init.body = JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach Novita API: ${err.message}` });
  }
});

const server = http.createServer(app);

// Interactive terminal: one WebSocket per PTY session. Auth is the ticket
// minted above (single-use, 30s TTL) — never a raw key or account id, since
// those would otherwise have to ride in the (unencryptable-by-us) URL.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }
  const ticket = searchParams.get('ticket');
  const claim = ticket && terminalTickets.get(ticket);
  terminalTickets.delete(ticket);
  if (!claim || claim.expires < Date.now()) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const cols = Math.max(20, parseInt(searchParams.get('cols'), 10) || 80);
  const rows = Math.max(10, parseInt(searchParams.get('rows'), 10) || 24);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, { ...claim, cols, rows }));
});

wss.on('connection', (ws, { apiKey, sandboxId, cols, rows }) => {
  // PTY setup is a real network round-trip to Novita, but the socket can
  // start receiving frames (an initial resize, fast typing) the instant the
  // handshake completes — well before that finishes. Attach the listener
  // immediately and queue anything that arrives early, so nothing is
  // silently dropped while `term` doesn't exist yet.
  let term = null;
  let closed = false;
  const backlog = [];

  const handleFrame = (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize') { term.resize(msg.cols, msg.rows); return; }
      } catch {
        /* not JSON — fall through and treat as input */
      }
    }
    term.sendInput(data);
  };

  ws.on('message', (data, isBinary) => {
    if (!term) { backlog.push({ data, isBinary }); return; }
    handleFrame(data, isBinary);
  });
  ws.on('close', () => { closed = true; term?.kill(); });
  ws.on('error', () => { closed = true; term?.kill(); });

  sandboxLib.openTerminal(apiKey, sandboxId, {
    cols,
    rows,
    onData: (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    },
  }).then((handle) => {
    if (closed) { handle.kill(); return; }
    term = handle;
    for (const frame of backlog.splice(0)) handleFrame(frame.data, frame.isBinary);
  }).catch((err) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
  });
});

server.listen(PORT, () => {
  console.log(`Novita dashboard running at http://localhost:${PORT}`);
});
