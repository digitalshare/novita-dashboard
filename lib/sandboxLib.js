'use strict';

const { Novita } = require('novita-sandbox');
const sandboxNames = require('./sandboxNames');

// The port getSshConnectionCommand() builds its wss:// URL against, and where
// the "ssh-ready" template's own proxy listens — enableSshAccess has to match
// it for both to be interchangeable.
const SSH_PROXY_PORT = 8081;
const WEBSOCAT_PATH = '/usr/local/bin/websocat';
const WEBSOCAT_VERSION = 'v1.13.0';

function client(apiKey) {
  if (!apiKey) throw new Error('Missing Novita API key.');
  return new Novita({ apiKey });
}

/**
 * sandbox.commands.run(cmd, {background: false}) does NOT resolve with a
 * {exitCode, stdout, stderr} result when the command exits nonzero — it
 * REJECTS, with a CommandExitError (confirmed by direct testing: a plain
 * `command -v something-not-installed` throws "CommandExitError: exit
 * status 1" instead of resolving with exitCode: 1). That's fine for a
 * command that's only ever expected to succeed, but wrong for anything
 * that treats a nonzero exit as a normal, meaningful outcome to branch on
 * (checking whether a binary exists, running a user-supplied command via
 * the AI Agent's run_command tool, etc.) — for those, every call site
 * would otherwise need its own try/catch to unwrap CommandExitError back
 * into the result shape it should have gotten in the first place. This
 * normalizes it once so exitCode is always just data, never a thrown path.
 */
async function runForeground(sandbox, cmd, opts) {
  try {
    return await sandbox.commands.run(cmd, { ...opts, background: false });
  } catch (err) {
    if (err.constructor?.name === 'CommandExitError') {
      return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}

function toPlainInfo(info) {
  return {
    sandboxId: info.sandboxId,
    templateId: info.templateId,
    // A renamed sandbox lives in sandboxNames (edit-time convention) and
    // wins; metadata.name is the name given at creation (fixed forever on
    // Novita's side — there's no rename API) and is the fallback for
    // sandboxes never renamed; info.name is the platform's own field, but
    // for a plain sandbox.create() (no explicit template) it's just the
    // default template's alias ("base") echoed back, not a per-sandbox
    // name, so it's never used here.
    name: sandboxNames.getName(info.sandboxId) || info.metadata?.name || info.sandboxId,
    metadata: info.metadata || {},
    state: info.state,
    cpuCount: info.cpuCount,
    memoryMB: info.memoryMB,
    startedAt: info.startedAt,
    endAt: info.endAt,
    allowInternetAccess: info.allowInternetAccess,
    volumeMounts: info.volumeMounts || [],
  };
}

/**
 * Every function below accepts either a sandboxId or a name (creation-time
 * metadata.name, or a later rename via sandboxNames) and resolves it here.
 * Checks our own rename store first since it's an instant local lookup and
 * always wins when present; falls back to the metadata.name given at
 * creation; falls through to treating the input as a raw ID when neither
 * matches, so existing IDs keep working untouched.
 */
/**
 * A sandbox that times out on its own (rather than being explicitly killed
 * through this app) never triggers sandboxNames.forget() — the platform
 * doesn't tell us it happened. So a name mapping can point at a sandbox
 * that's long gone, and a naive lookup would either resolve to a dead ID or
 * (worse, for the duplicate-name check) permanently block reusing that name
 * for a real new sandbox. This confirms the mapped ID is still real and
 * self-heals the local store when it isn't, rather than leaving a stale
 * entry to keep causing confusing failures indefinitely.
 */
async function resolveRenamedIfAlive(apiKey, name) {
  const mapped = sandboxNames.findBySandboxName(name);
  if (!mapped) return undefined;
  const novita = client(apiKey);
  try {
    await novita.sandbox.getInfo(mapped);
    return mapped;
  } catch {
    sandboxNames.forget(mapped);
    return undefined;
  }
}

async function resolveSandboxId(apiKey, nameOrId) {
  if (!nameOrId) throw new Error('Sandbox name or ID is required.');
  const renamed = await resolveRenamedIfAlive(apiKey, nameOrId);
  if (renamed) return renamed;
  const novita = client(apiKey);
  const paginator = novita.sandbox.list({ query: { metadata: { name: nameOrId } }, limit: 5 });
  const matches = await paginator.nextItems();
  if (matches.length > 1) {
    throw new Error(`Multiple sandboxes are named "${nameOrId}" — use its sandbox ID instead: ${matches.map((m) => m.sandboxId).join(', ')}`);
  }
  if (matches.length === 1) return matches[0].sandboxId;
  return nameOrId;
}

/**
 * A name is unique across both the creation-time metadata.name convention
 * and any later renames, so this checks both before allowing create/rename
 * to claim it.
 */
async function findSandboxIdByAnyName(apiKey, name) {
  const renamed = await resolveRenamedIfAlive(apiKey, name);
  if (renamed) return renamed;
  const novita = client(apiKey);
  const matches = await novita.sandbox.list({ query: { metadata: { name } }, limit: 1 }).nextItems();
  return matches[0]?.sandboxId;
}

async function renameSandbox(apiKey, nameOrId, newName) {
  if (!newName || !newName.trim()) throw new Error('New name is required.');
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const clash = await findSandboxIdByAnyName(apiKey, newName);
  if (clash && clash !== sandboxId) throw new Error(`A sandbox named "${newName}" already exists (${clash}). Pick a different name.`);
  sandboxNames.setName(sandboxId, newName.trim());
  return getSandbox(apiKey, sandboxId);
}

async function listSandboxes(apiKey, { state } = {}) {
  const novita = client(apiKey);
  const query = {};
  if (state && state.length) query.state = state;
  const paginator = novita.sandbox.list({ query, limit: 100 });
  const all = [];
  let page = await paginator.nextItems();
  all.push(...page);
  while (paginator.hasNext && all.length < 500) {
    page = await paginator.nextItems();
    all.push(...page);
  }
  return all.map(toPlainInfo);
}

async function createSandbox(apiKey, { name, template, timeoutMs, metadata, envs, allowInternetAccess, volumeMounts, sshPublicKey } = {}) {
  const novita = client(apiKey);
  const mergedMetadata = { ...(metadata || {}) };
  if (name) {
    const clash = await findSandboxIdByAnyName(apiKey, name);
    if (clash) throw new Error(`A sandbox named "${name}" already exists (${clash}). Pick a different name.`);
    mergedMetadata.name = name;
  }
  const mountMap = {};
  if (volumeMounts?.length) {
    const existingVolumes = await novita.volume.list();
    for (const m of volumeMounts) {
      if (!m.volumeName || !m.mountPath) continue;
      if (!existingVolumes.some((v) => v.name === m.volumeName)) {
        await novita.volume.create(m.volumeName, { quotaSizeGiB: 1 });
      }
      mountMap[m.mountPath] = m.volumeName;
    }
  }
  const sandbox = await novita.sandbox.create({
    template: template || undefined,
    timeoutMs: timeoutMs || 10 * 60 * 1000,
    metadata: Object.keys(mergedMetadata).length ? mergedMetadata : undefined,
    envs: envs || undefined,
    allowInternetAccess: allowInternetAccess !== false,
    volumeMounts: Object.keys(mountMap).length ? mountMap : undefined,
  });

  // SSH access is per-sandbox (a shared template would let every sandbox
  // spawned from it accept the same key), so the public key is injected
  // here at creation time rather than baked into the "ssh-ready" template
  // image itself. Harmless to write even on a non-SSH template — it just
  // won't be reachable without sshd/websocat running, which only the
  // "ssh-ready" template provides.
  if (sshPublicKey && sshPublicKey.trim()) {
    await runForeground(
      sandbox,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys << 'NOVITA_DASHBOARD_EOF'\n${sshPublicKey.trim()}\nNOVITA_DASHBOARD_EOF\nchmod 600 ~/.ssh/authorized_keys`,
      { timeoutMs: 15000 },
    );
  }

  return toPlainInfo(await sandbox.getInfo());
}

/**
 * The SSH proxy (websocat, baked into the "ssh-ready" template's start
 * command) listens on port 8081 and forwards to the sandbox's real sshd on
 * port 22. The hostname Novita actually serves this on includes a
 * region segment (e.g. "us-phx-1") that isn't predictable from the sandbox
 * ID alone — confirmed by a failed connection against the generic
 * "sandbox.novita.ai" host from the docs, then success once using
 * `sandbox.getHost(port)`, which returns the real region-qualified host.
 */
async function getSshConnectionCommand(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);
  const host = sandbox.getHost(SSH_PROXY_PORT);
  return {
    sandboxId,
    host,
    // The bit after "user@" is just an SSH host alias (ProxyCommand handles
    // the actual connection) — but it doubles as the known_hosts lookup key.
    // A fixed placeholder like "dummy" made every sandbox share one
    // known_hosts entry, so connecting to a second sandbox after the first
    // triggered a false "REMOTE HOST IDENTIFICATION HAS CHANGED" warning
    // (confirmed firsthand). Using the sandboxId keeps each sandbox's host
    // key cached separately.
    command: `ssh -o 'ProxyCommand=websocat --binary -B 65536 - wss://${host}' user@${sandboxId}`,
  };
}

/**
 * The SSH path needs two things inside the sandbox: a websocat listener on
 * 8081 bridging to sshd on 22 (Novita only exposes HTTP/WS on the public
 * host, so port 22 is unreachable directly), and the caller's public key in
 * authorized_keys. The "ssh-ready" template provides both; any other
 * template (including the default "base") provides neither, so
 * getSshConnectionCommand would happily hand back a well-formed command that
 * dies with "502 Bad Gateway" because nothing is listening. This provisions
 * those two things on an already-running sandbox so SSH works regardless of
 * which template it was created from.
 *
 * Idempotent by design — it's the repair path for a sandbox created without
 * SSH, so re-running it (or running it on an ssh-ready sandbox that already
 * has everything) must be harmless rather than duplicating keys or starting
 * a second proxy that fails to bind.
 */
async function enableSshAccess(apiKey, nameOrId, { sshPublicKey } = {}) {
  if (!sshPublicKey || !sshPublicKey.trim()) throw new Error('An SSH public key is required.');
  const key = sshPublicKey.trim();
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+)\s+\S+/.test(key)) {
    throw new Error('That does not look like an SSH public key (expected e.g. "ssh-ed25519 AAAA..."). Paste the contents of a .pub file, not a private key.');
  }

  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);

  const sudo = (await runForeground(sandbox, '[ "$(id -u)" = "0" ] && echo "" || echo "sudo -n -E"', { timeoutMs: 10000 })).stdout.trim();

  // uname -m rather than a hardcoded x86_64: the same deploy should keep
  // working if a sandbox is ever scheduled on arm64.
  const install = await runForeground(
    sandbox,
    `command -v websocat >/dev/null || (curl -fsSL -o /tmp/websocat https://github.com/vi/websocat/releases/download/${WEBSOCAT_VERSION}/websocat.$(uname -m)-unknown-linux-musl && chmod +x /tmp/websocat && ${sudo} mv /tmp/websocat ${WEBSOCAT_PATH})`,
    { timeoutMs: 120000 },
  );
  if (install.exitCode !== 0) {
    throw new Error(`Failed to install the websocat SSH proxy: ${install.stderr || install.stdout}`);
  }

  // The key goes in via files.write to a temp path, then a shell step appends
  // it — writing authorized_keys directly would clobber any key already there
  // (including the one an "ssh-ready" sandbox was created with), and
  // interpolating the key into a shell command risks the shell reinterpreting
  // it. grep -qxF makes a repeat run a no-op instead of appending a duplicate.
  await sandbox.files.write('/tmp/.ssh-key-to-add', `${key}\n`);
  const authorize = await runForeground(
    sandbox,
    'set -e; for h in "$HOME" /root; do [ -d "$h" ] || continue; ' +
      `${sudo} mkdir -p "$h/.ssh"; ` +
      `grep -qxF "$(cat /tmp/.ssh-key-to-add)" "$h/.ssh/authorized_keys" 2>/dev/null || cat /tmp/.ssh-key-to-add | ${sudo} tee -a "$h/.ssh/authorized_keys" >/dev/null; ` +
      // sshd silently ignores an authorized_keys that is group/world writable
      // or owned by the wrong user, which is indistinguishable from the key
      // being rejected. Ownership is derived from the directory itself so this
      // stays correct for both /root and a non-root $HOME.
      `${sudo} chmod 700 "$h/.ssh"; ${sudo} chmod 600 "$h/.ssh/authorized_keys"; ` +
      `${sudo} chown -R "$(stat -c %u:%g "$h")" "$h/.ssh"; ` +
      'done; rm -f /tmp/.ssh-key-to-add',
    { timeoutMs: 30000 },
  );
  if (authorize.exitCode !== 0) {
    throw new Error(`Failed to install the public key: ${authorize.stderr || authorize.stdout}`);
  }

  // Only start a proxy if one isn't already listening — on an "ssh-ready"
  // sandbox the template's own websocat already holds 8081, and a second one
  // would just fail to bind.
  const proxy = await runForeground(
    sandbox,
    `(ss -ltn 2>/dev/null || netstat -ltn) | grep -q ':${SSH_PROXY_PORT} ' || ` +
      `((nohup ${WEBSOCAT_PATH} --binary -B 65536 ws-l:0.0.0.0:${SSH_PROXY_PORT} tcp:127.0.0.1:22 > /tmp/websocat.log 2>&1 &) && sleep 2 && ` +
      `((ss -ltn 2>/dev/null || netstat -ltn) | grep -q ':${SSH_PROXY_PORT} ' || (cat /tmp/websocat.log; exit 1)))`,
    { timeoutMs: 40000 },
  );
  if (proxy.exitCode !== 0) {
    throw new Error(`websocat could not listen on ${SSH_PROXY_PORT}: ${proxy.stderr || proxy.stdout}`);
  }

  return getSshConnectionCommand(apiKey, sandboxId);
}

async function getSandbox(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  return toPlainInfo(await novita.sandbox.getInfo(sandboxId));
}

async function killSandbox(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  await novita.sandbox.kill(sandboxId);
  sandboxNames.forget(sandboxId);
  return { sandboxId, killed: true };
}

async function pauseSandbox(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  await novita.sandbox.pause(sandboxId);
  return { sandboxId, paused: true };
}

async function resumeSandbox(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);
  return toPlainInfo(await sandbox.getInfo());
}

async function runCommand(apiKey, nameOrId, cmd, { background = false, timeoutMs, envs } = {}) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);
  if (background) {
    await sandbox.commands.run(cmd, { background: true, envs });
    return { started: true, background: true };
  }
  const result = await runForeground(sandbox, cmd, { timeoutMs, envs });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * CPU/memory/disk usage for a sandbox. The API returns a short time series;
 * callers generally just want the latest sample plus a small window for a
 * sparkline, so this returns the whole series (newest last) and lets the
 * caller pick.
 */
async function getSandboxMetrics(apiKey, nameOrId) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const series = await novita.sandbox.getMetrics(sandboxId);
  return series.map((m) => ({
    timestamp: m.timestamp,
    cpuUsedPct: m.cpuUsedPct,
    cpuCount: m.cpuCount,
    memUsedMB: Math.round(m.memUsed / (1024 * 1024)),
    memTotalMB: Math.round(m.memTotal / (1024 * 1024)),
    diskUsedMB: Math.round(m.diskUsed / (1024 * 1024)),
    diskTotalMB: Math.round(m.diskTotal / (1024 * 1024)),
  }));
}

/**
 * Sandbox templates — a namespace entirely separate from the GPU-instance
 * templates at gpu-instance/openapi/v1/templates, despite the shared name.
 * Querying the GPU-instance endpoint for these returns an empty list even when
 * sandbox templates exist (confirmed: that endpoint reported total=0 while this
 * one returned the account's "ssh-ready" template).
 *
 * This lists only templates the account OWNS — it is not the set of valid
 * `template` values for sandbox.create(). Novita's built-in templates are
 * absent from it yet still work (confirmed: creating a "browser-chromium"
 * sandbox succeeds while that alias never appears here), so callers must not
 * treat a missing alias as unusable.
 *
 * The paginator here exposes nextPage() returning the raw response envelope,
 * not the nextItems() that novita.sandbox.list() uses — the two differ, and
 * nextItems() is simply not a function on this one.
 */
async function listSandboxTemplates(apiKey) {
  const novita = client(apiKey);
  const paginator = novita.template.list();
  const all = [];
  // Bounded rather than while(hasNext): a pagination quirk that never flips
  // hasNext false would otherwise spin forever inside a request handler.
  for (let i = 0; i < 20; i += 1) {
    const page = await paginator.nextPage();
    all.push(...(page.templates || []));
    if (all.length >= (page.total || 0) || !(page.templates || []).length) break;
  }
  return all.map((t) => ({
    templateId: t.templateId,
    // A template is referenced by alias when creating a sandbox ("ssh-ready"),
    // so that's the useful identifier to surface; `names` is the same thing
    // prefixed with the owner UUID, which isn't what create() accepts.
    aliases: t.aliases || [],
    name: (t.aliases || [])[0] || t.templateId,
    buildStatus: t.buildStatus,
    cpuCount: t.cpuCount,
    memoryMB: t.memoryMB,
    diskSizeMB: t.diskSizeMB,
    public: t.public,
    spawnCount: t.spawnCount,
    createdAt: t.createdAt,
    lastSpawnedAt: t.lastSpawnedAt,
  }));
}

/**
 * Persistent Volumes — a separate storage resource decoupled from any one
 * sandbox's lifecycle. Unlike a sandbox's own disk (wiped on kill/timeout),
 * a Volume survives independently and can be mounted into a brand-new
 * sandbox later, at the same path, with its contents intact. This is how
 * data (e.g. this app's own data/accounts.json) survives sandbox
 * recreation — confirmed working end-to-end against the live API, though
 * it isn't yet in Novita's public sandbox docs.
 */
async function listVolumes(apiKey) {
  const novita = client(apiKey);
  const [volumes, sandboxes] = await Promise.all([novita.volume.list(), listSandboxes(apiKey)]);
  return volumes.map((v) => ({
    ...v,
    mountedOn: sandboxes
      .flatMap((s) => s.volumeMounts.filter((m) => m.name === v.name).map((m) => ({ sandboxId: s.sandboxId, sandboxName: s.name, path: m.path }))),
  }));
}

async function createVolume(apiKey, name, quotaSizeGiB) {
  const novita = client(apiKey);
  const existing = (await novita.volume.list()).find((v) => v.name === name);
  if (existing) throw new Error(`A volume named "${name}" already exists (${existing.volumeId}).`);
  const vol = await novita.volume.create(name, { quotaSizeGiB: quotaSizeGiB || 1 });
  return { volumeId: vol.volumeId, name: vol.name };
}

async function deleteVolume(apiKey, nameOrId) {
  const novita = client(apiKey);
  const volumes = await novita.volume.list();
  const match = volumes.find((v) => v.name === nameOrId || v.volumeId === nameOrId);
  const volumeId = match ? match.volumeId : nameOrId;
  await novita.volume.destroy(volumeId);
  return { volumeId, deleted: true };
}

async function mountVolume(apiKey, sandboxNameOrId, volumeName, mountPath) {
  const sandboxId = await resolveSandboxId(apiKey, sandboxNameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);

  // The platform allows a volume to be mounted at most once per sandbox
  // (regardless of path), and it rejects a second mount with a bare
  // "409: Volume is already mounted" that names neither the volume nor
  // where it actually landed — genuinely confusing when the path you asked
  // for then turns up empty. Check first and give an error that actually
  // says where to look instead.
  const existingMounts = (await sandbox.getInfo()).volumeMounts || [];
  const sameVolume = existingMounts.find((m) => m.name === volumeName);
  if (sameVolume) {
    throw new Error(`Volume "${volumeName}" is already mounted on this sandbox at ${sameVolume.path} (not ${mountPath}) — a volume can only be mounted once per sandbox.`);
  }
  const pathTaken = existingMounts.find((m) => m.path === mountPath);
  if (pathTaken) {
    throw new Error(`${mountPath} is already in use on this sandbox by volume "${pathTaken.name}". Choose a different mount path.`);
  }

  const info = await sandbox.mountVolume(volumeName, mountPath);
  return toPlainInfo(info);
}

async function unmountVolume(apiKey, sandboxNameOrId, mountPath) {
  const sandboxId = await resolveSandboxId(apiKey, sandboxNameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);
  const info = await sandbox.unmountVolume(mountPath);
  return toPlainInfo(info);
}

/**
 * Opens a live PTY session for an interactive terminal. `onData` receives
 * raw output chunks (Uint8Array) as they arrive; the returned handle lets a
 * caller (the WebSocket bridge in server.js) push keystrokes, resize, and
 * tear the session down.
 */
async function openTerminal(apiKey, nameOrId, { cols, rows, onData }) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);
  const handle = await sandbox.pty.create({ cols, rows, onData });

  // Keystrokes arrive as a burst of separate WebSocket frames; each maps to
  // its own sendInput RPC call, and those aren't guaranteed to land in order
  // if fired concurrently (observed: fast typing came out scrambled with
  // stray "&"s that even backgrounded shell jobs). Chain them so call N+1
  // only goes out once call N's RPC has actually completed. Both sendInput
  // and resize can also reject once the PTY process has exited (e.g. after
  // the shell was killed) — left uncaught, that's an unhandled rejection
  // that takes the whole Node process down, not just this session, so every
  // call here is swallowed after logging rather than allowed to throw.
  let chain = Promise.resolve();
  const serialize = (fn) => {
    chain = chain.then(fn, fn).catch((err) => {
      console.error(`[sandbox ${sandboxId}] pty error:`, err.message);
    });
    return chain;
  };

  return {
    pid: handle.pid,
    sendInput: (data) => serialize(() => sandbox.pty.sendInput(handle.pid, data)),
    resize: (c, r) => serialize(() => sandbox.pty.resize(handle.pid, { cols: c, rows: r })),
    kill: () => sandbox.pty.kill(handle.pid).catch(() => {}),
  };
}

/**
 * Provisions a sandbox for AI-driven web development: installs the Claude
 * Code CLI and a headless Chromium (via Playwright) so a coding agent can
 * build and test a web app end-to-end — including visually, via screenshots
 * — with no display server. Runs on any template; ~1-2 min on a plain
 * "base" template while it downloads the browser, faster on one (like
 * "browser-chromium") that already has it cached.
 *
 * Auth: Claude Code needs one of ANTHROPIC_API_KEY (API-key billing, works
 * immediately) or CLAUDE_CODE_OAUTH_TOKEN (a Pro/Max/Team/Enterprise
 * subscription — but that token can only be minted by running
 * `claude setup-token` interactively somewhere with a browser first; there
 * is no way to complete that from inside a headless sandbox). Either one,
 * once provided, is written to /etc/profile.d/ so it's picked up by every
 * future login-shell command on this sandbox (sandbox.commands.run invokes
 * `bash -l`, confirmed by inspecting its actual process args) — not just
 * the one that installed it.
 */
/**
 * Ensures Node 22+ (needed because novita-sandbox's own bundle does
 * require("chalk"), and chalk 5 is ESM-only — only require()-able from Node
 * 22.12+) and returns the prefix to put in front of any other command in
 * this sandbox that needs root (apt-get, a global npm install into a
 * root-owned prefix, ...).
 *
 * Templates differ in who they run commands as: the "base" template runs as
 * root, so plain `apt-get install` just works; "browser-chromium" (Ubuntu
 * 22.04) runs as a non-root `user` — confirmed firsthand, apt-get there
 * fails with "Could not open lock file ... Permission denied" — but that
 * user has passwordless sudo, so prefixing with `sudo -n` fixes it. Always
 * prefixing unconditionally would break the root case if `sudo` itself
 * isn't installed on that image (not guaranteed on a minimal template), so
 * this checks `id -u` first and only adds the prefix when actually needed.
 * `-E` preserves the caller's environment (crucially $HOME) rather than
 * resetting to root's — without it, a "sudo playwright install" downloads
 * the browser into /root/.cache/ms-playwright, invisible to the actual
 * non-root user's later `require('playwright').chromium.launch()`.
 */
async function ensureNode22(sandbox) {
  const sudo = (await runForeground(sandbox, '[ "$(id -u)" = "0" ] && echo "" || echo "sudo -n -E"', { timeoutMs: 10000 })).stdout.trim();

  const ensureNode = await runForeground(
    sandbox,
    '(test -x /usr/bin/node && [ "$(/usr/bin/node -e \'console.log(process.versions.node.split(".")[0])\')" -ge 22 ]) || ' +
      `(curl -fsSL https://deb.nodesource.com/setup_22.x | ${sudo} bash - >/tmp/node-setup.log 2>&1 && ${sudo} apt-get install -y nodejs >>/tmp/node-setup.log 2>&1)`,
    { timeoutMs: 120000 },
  );
  if (ensureNode.exitCode !== 0) {
    const log = await runForeground(sandbox, 'tail -n 30 /tmp/node-setup.log 2>&1 || true', { timeoutMs: 10000 });
    throw new Error(`Failed to provision Node.js: ${ensureNode.stderr || ensureNode.stdout || log.stdout}`);
  }
  return sudo;
}

async function setupClaudeCodeDevEnv(apiKey, nameOrId, { anthropicApiKey, claudeCodeOauthToken } = {}) {
  const sandboxId = await resolveSandboxId(apiKey, nameOrId);
  const novita = client(apiKey);
  const sandbox = await novita.sandbox.connect(sandboxId);

  const sudo = await ensureNode22(sandbox);

  if (anthropicApiKey || claudeCodeOauthToken) {
    // A key/token pasted from a terminal that soft-wrapped it across lines
    // can pick up a stray space or newline at the wrap point — confirmed
    // firsthand: a pasted OAuth token had a literal double-space in the
    // middle, which Anthropic's API then rejected outright with "401 OAuth
    // access token is invalid" (not a hang, despite how it looked from the
    // terminal — the failure was immediate). A real key/token never
    // contains whitespace, so strip all of it rather than just trimming
    // the ends.
    const clean = (s) => s.replace(/\s+/g, '');
    const lines = ['#!/bin/sh'];
    if (anthropicApiKey) lines.push(`export ANTHROPIC_API_KEY=${JSON.stringify(clean(anthropicApiKey))}`);
    if (claudeCodeOauthToken) lines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${JSON.stringify(clean(claudeCodeOauthToken))}`);
    await sandbox.files.write('/etc/profile.d/claude-code-env.sh', `${lines.join('\n')}\n`);
  }

  const install = await runForeground(sandbox, `${sudo} /usr/bin/npm install -g @anthropic-ai/claude-code playwright`, { timeoutMs: 180000 });
  if (install.exitCode !== 0) {
    throw new Error(`Failed to install Claude Code: ${install.stderr || install.stdout}`);
  }

  const prefix = (await runForeground(sandbox, '/usr/bin/npm config get prefix', { timeoutMs: 15000 })).stdout.trim();
  const claudeBin = `${prefix}/bin/claude`;
  const playwrightBin = `${prefix}/bin/playwright`;

  const claudeCheck = await runForeground(sandbox, `"${claudeBin}" --version`, { timeoutMs: 15000 });
  if (claudeCheck.exitCode !== 0) {
    throw new Error(`Claude Code installed but "${claudeBin} --version" failed: ${claudeCheck.stderr || claudeCheck.stdout}`);
  }

  // Always ensure Playwright's OWN bundled Chromium, even on templates (like
  // browser-chromium) that already ship a system browser: the verification
  // step below drives the browser through `require('playwright')`, which
  // looks for Playwright's own downloaded browser under ~/.cache/ms-playwright
  // regardless of what else is on the system — skipping this on the (correct)
  // assumption that a system browser would cover it left that require()
  // pointed at a browser that was never fetched. `playwright install` is a
  // fast no-op if it's already there (e.g. baked into the template image),
  // so this costs nothing on the templates it's meant to save time on.
  const pwInstall = await runForeground(sandbox, `${sudo} "${playwrightBin}" install --with-deps chromium`, { timeoutMs: 300000 });
  if (pwInstall.exitCode !== 0) {
    throw new Error(`Claude Code installed, but Playwright's Chromium install failed: ${pwInstall.stderr || pwInstall.stdout}`);
  }
  const browserStatus = 'Headless Chromium ready via Playwright.';

  // A binary being present doesn't mean it can actually run one — confirmed
  // firsthand: plain `chromium.launch()` crashes every time on this platform
  // with "V8 process OOM (Failed to reserve virtual memory for CodeRange)",
  // a virtual-memory reservation failure V8 hits in this sandbox's runtime
  // environment (ulimit -v is unlimited; something below that still balks at
  // V8's normal upfront reservation). --js-flags=--jitless sidesteps it by
  // skipping JIT compilation entirely — slower execution, but it actually
  // works, which plain launch does not. So: verify with the real flags a
  // caller needs, not just `--version`, and hand those flags back — a
  // silent "success" here that then fails on first real use would be worse
  // than surfacing the failure now.
  const launchCheck = await runForeground(
    sandbox,
    `timeout 20 /usr/bin/node -e "` +
      `const {chromium}=require('${playwrightBin.replace('/bin/playwright', '/lib/node_modules/playwright')}');` +
      `(async()=>{const b=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--js-flags=--jitless']});` +
      `const p=await b.newPage();await p.goto('about:blank');await b.close();console.log('OK');})()` +
      `.catch(e=>{console.error(e.message);process.exit(1)})"`,
    { timeoutMs: 25000 },
  );
  if (launchCheck.exitCode !== 0) {
    throw new Error(`Chromium is installed but failed a real launch test: ${launchCheck.stderr || launchCheck.stdout}`);
  }
  const launchArgs = "['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--jitless']";

  return {
    sandboxId,
    claudeBinary: claudeBin,
    claudeVersion: claudeCheck.stdout.trim(),
    playwrightBinary: playwrightBin,
    browserStatus: `${browserStatus} Verified with a real launch + page load.`,
    authConfigured: Boolean(anthropicApiKey || claudeCodeOauthToken),
    usage: `Run one-shot tasks with: ${claudeBin} -p "your prompt"  •  Launch the browser with: const { chromium } = require('playwright'); await chromium.launch({ args: ${launchArgs} }); — those exact args are required in this environment (plain chromium.launch() crashes with a V8 virtual-memory error here).`,
  };
}

module.exports = {
  resolveSandboxId,
  renameSandbox,
  listSandboxes,
  createSandbox,
  getSandbox,
  killSandbox,
  pauseSandbox,
  resumeSandbox,
  runCommand,
  getSandboxMetrics,
  openTerminal,
  setupClaudeCodeDevEnv,
  listVolumes,
  createVolume,
  deleteVolume,
  mountVolume,
  unmountVolume,
  getSshConnectionCommand,
  enableSshAccess,
  listSandboxTemplates,
};
