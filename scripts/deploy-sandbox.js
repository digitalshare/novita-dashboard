#!/usr/bin/env node
'use strict';

/**
 * Deploys THIS project into a Novita sandbox and starts it there.
 *
 * The dashboard normally runs on localhost; this script runs an instance of
 * it inside Novita itself, reachable over a public sandbox host. Two things
 * make that non-obvious and are handled here:
 *
 *  - data/ is gitignored local state (saved API keys, sandbox name aliases).
 *    It is NOT uploaded. Instead the persistent Volume is mounted at
 *    <APP_DIR>/data, which is exactly the path lib/accounts.js writes to, so
 *    accounts saved in the deployed instance survive the sandbox being
 *    killed or timing out.
 *  - node_modules is not uploaded either (slow, and native deps must match
 *    the sandbox's platform) — deps are installed inside the sandbox from
 *    package-lock.json.
 */

const fs = require('fs');
const path = require('path');
const { Novita } = require('novita-sandbox');

const API_KEY = process.env.NOVITA_API_KEY;
const SANDBOX_NAME = process.env.SANDBOX_NAME || 'dashboard-prod';
const VOLUME_NAME = process.env.VOLUME_NAME || 'dashboard-data-prod';
// Optional prebuilt template (see scripts/build-dashboard-template.js). It
// carries Node 22 and websocat already installed, which lets the provisioning
// steps below detect them and skip — they stay in place so a deploy on the
// default base template keeps working unchanged.
const TEMPLATE = process.env.TEMPLATE || undefined;
const APP_DIR = '/app';
const APP_PORT = 4173;
// The port the dashboard's "SSH" button expects a WebSocket->sshd proxy on
// (lib/sandboxLib.js getSshConnectionCommand builds its command against it).
const SSH_PROXY_PORT = 8081;
const SSH_PUBLIC_KEY_PATH = process.env.SSH_PUBLIC_KEY_PATH
  || path.join(process.env.HOME || '', '.ssh', 'novita_dashboard_v2.pub');
const WEBSOCAT_VERSION = 'v1.13.0';
// Novita kills a sandbox at its timeout no matter how busy it is, so this is
// the real lifetime of the deployed instance, not an idle timeout. The
// platform rejects anything over 1 hour outright ("400: Timeout cannot be
// greater than 1 hours"), so that ceiling is the default — a longer-lived
// instance has to be kept alive by extending the timeout on the running
// sandbox, not requested up front.
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60 * 60 * 1000);

const ROOT = path.join(__dirname, '..');
// Everything the server needs at runtime. data/ and node_modules/ are
// deliberately absent (see the header comment).
const UPLOAD = ['package.json', 'package-lock.json', 'server.js', 'lib', 'public'];

function collectFiles(relPath, out = []) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isDirectory()) {
    for (const entry of fs.readdirSync(abs)) {
      if (entry === '.DS_Store') continue;
      collectFiles(path.join(relPath, entry), out);
    }
    return out;
  }
  out.push({ path: `${APP_DIR}/${relPath.split(path.sep).join('/')}`, data: fs.readFileSync(abs, 'utf8') });
  return out;
}

/**
 * sandbox.commands.run REJECTS with CommandExitError on a nonzero exit
 * instead of resolving (same quirk lib/sandboxLib.js documents), so a step
 * that legitimately fails would otherwise throw an error whose stdout/stderr
 * are hidden inside the exception. Normalize so failures are reportable.
 */
async function run(sandbox, label, cmd, timeoutMs) {
  process.stdout.write(`  ${label}... `);
  let result;
  try {
    result = await sandbox.commands.run(cmd, { timeoutMs, background: false });
  } catch (err) {
    if (err.constructor?.name !== 'CommandExitError') throw err;
    result = { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
  }
  if (result.exitCode !== 0) {
    console.log('FAILED');
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`);
  }
  console.log('ok');
  return result;
}

/**
 * Makes the dashboard's "SSH" button actually work against this sandbox.
 *
 * Novita only exposes a sandbox over HTTP/WebSocket on its public host, so
 * port 22 is unreachable from outside even though sshd is running on it. The
 * connection has to be tunneled: the command getSshConnectionCommand() hands
 * out pipes SSH through `websocat` to wss://<SSH_PROXY_PORT>-<host>, which
 * means the sandbox needs a WebSocket listener on that port forwarding to
 * 127.0.0.1:22. The "ssh-ready" template bakes that proxy into its start
 * command, but this deploy uses the default base template (it needs Node 22
 * and the app, not a prebuilt SSH image), so the proxy is installed here
 * instead — without it the button emits a valid-looking command that dies
 * with "502 Bad Gateway", because nothing is listening.
 *
 * Returns the public SSH host, or null when no public key is available (SSH
 * is a convenience — a missing key must not fail an otherwise good deploy).
 */
async function setupSsh(sandbox, sudo) {
  if (!fs.existsSync(SSH_PUBLIC_KEY_PATH)) {
    console.log(`\nSkipping SSH setup: no public key at ${SSH_PUBLIC_KEY_PATH}`);
    console.log('  Set SSH_PUBLIC_KEY_PATH to enable it.');
    return null;
  }
  const pubKey = fs.readFileSync(SSH_PUBLIC_KEY_PATH, 'utf8').trim();

  console.log('Setting up SSH access...');
  await run(
    sandbox,
    'install websocat',
    `command -v websocat >/dev/null || (${sudo} curl -fsSL -o /usr/local/bin/websocat https://github.com/vi/websocat/releases/download/${WEBSOCAT_VERSION}/websocat.$(uname -m)-unknown-linux-musl && ${sudo} chmod +x /usr/local/bin/websocat)`,
    120000,
  );

  // Which account SSH lands in depends on the template (base runs as root,
  // others as `user`), and the command from getSshConnectionCommand() uses
  // "user@" purely as a known_hosts alias — the real login user comes from
  // the client's own SSH config. Authorizing both accounts means the command
  // works either way instead of failing on a detail the user didn't choose.
  // Written via files.write rather than a shell heredoc so no part of the key
  // can be reinterpreted by the shell.
  // Staged in /tmp and installed with sudo rather than written straight to
  // each home: on a non-root template (the prebuilt "dashboard-ready" runs as
  // `user`) files.write to /root fails outright with a permission error, which
  // previously killed SSH setup after an otherwise successful deploy.
  const staged = '/tmp/authorized_keys.deploy';
  await sandbox.files.write(staged, `${pubKey}\n`);
  for (const [home, owner] of [['/root', 'root:root'], ['/home/user', 'user:user']]) {
    // sshd silently ignores an authorized_keys file that is group/world
    // writable or owned by the wrong user, which looks exactly like a
    // rejected key. Fix ownership and modes before trusting it.
    await run(
      sandbox,
      `authorize key (${home})`,
      `${sudo} mkdir -p ${home}/.ssh && ${sudo} cp ${staged} ${home}/.ssh/authorized_keys `
        + `&& ${sudo} chmod 700 ${home}/.ssh && ${sudo} chmod 600 ${home}/.ssh/authorized_keys `
        + `&& ${sudo} chown -R ${owner} ${home}/.ssh`,
      20000,
    );
  }
  await run(sandbox, 'remove staged key', `rm -f ${staged}`, 15000);

  // sshd is installed by the template but not started by it (a sandbox has no
  // init system running services), so without this the proxy would connect to
  // a closed port 22 and SSH would fail with "Connection refused".
  await run(sandbox, 'start sshd', `(ss -ltn | grep -q ':22 ') || (${sudo} mkdir -p /run/sshd && ${sudo} ssh-keygen -A && ${sudo} /usr/sbin/sshd)`, 30000);

  await run(
    sandbox,
    `start websocat on ${SSH_PROXY_PORT}`,
    `(nohup websocat --binary -B 65536 ws-l:0.0.0.0:${SSH_PROXY_PORT} tcp:127.0.0.1:22 > /tmp/websocat.log 2>&1 &) && sleep 2 && (ss -ltn | grep -q ':${SSH_PROXY_PORT}' || (cat /tmp/websocat.log; exit 1))`,
    30000,
  );

  return sandbox.getHost(SSH_PROXY_PORT);
}

async function main() {
  if (!API_KEY) throw new Error('NOVITA_API_KEY is not set.');
  const novita = new Novita({ apiKey: API_KEY });

  const existing = await novita.sandbox.list({ query: { metadata: { name: SANDBOX_NAME } }, limit: 1 }).nextItems();
  if (existing.length) {
    throw new Error(`A sandbox named "${SANDBOX_NAME}" already exists (${existing[0].sandboxId}, state=${existing[0].state}). Kill it first or set SANDBOX_NAME.`);
  }

  const volumes = await novita.volume.list();
  if (!volumes.some((v) => v.name === VOLUME_NAME)) {
    console.log(`Creating volume ${VOLUME_NAME}...`);
    await novita.volume.create(VOLUME_NAME, { quotaSizeGiB: 1 });
  }

  console.log(`Creating sandbox "${SANDBOX_NAME}" (template ${TEMPLATE || 'base (default)'}, volume ${VOLUME_NAME} -> ${APP_DIR}/data)...`);
  const sandbox = await novita.sandbox.create({
    template: TEMPLATE,
    timeoutMs: TIMEOUT_MS,
    metadata: { name: SANDBOX_NAME },
    allowInternetAccess: true,
    volumeMounts: { [`${APP_DIR}/data`]: VOLUME_NAME },
    envs: { PORT: String(APP_PORT) },
  });
  const info = await sandbox.getInfo();
  console.log(`  sandboxId: ${info.sandboxId}`);

  const files = UPLOAD.flatMap((entry) => collectFiles(entry));
  console.log(`Uploading ${files.length} files to ${APP_DIR}...`);
  await sandbox.files.write(files);

  // The base template ships Node 20, but novita-sandbox's own bundle does
  // require("chalk") and chalk 5 is ESM-only — only require()-able from Node
  // 22.12+. On Node 20 the server therefore crashes on startup with
  // ERR_REQUIRE_ESM the moment it loads lib/sandboxLib.js (confirmed here),
  // so provisioning Node 22 is a hard requirement, not an optimization.
  // `sudo` is only prefixed when not already root, since a minimal template
  // running as root may not have sudo installed at all.
  const sudo = (await run(sandbox, 'detect root', '[ "$(id -u)" = "0" ] && echo "" || echo "sudo -n -E"', 15000)).stdout.trim();
  await run(
    sandbox,
    'ensure Node 22',
    '(test -x /usr/bin/node && [ "$(/usr/bin/node -e \'console.log(process.versions.node.split(".")[0])\')" -ge 22 ]) || ' +
      `(curl -fsSL https://deb.nodesource.com/setup_22.x | ${sudo} bash - >/tmp/node-setup.log 2>&1 && ${sudo} apt-get install -y nodejs >>/tmp/node-setup.log 2>&1) || (tail -n 20 /tmp/node-setup.log; exit 1)`,
    240000,
  );
  await run(sandbox, 'node --version', '/usr/bin/node --version', 15000);
  await run(sandbox, 'npm ci --omit=dev', `cd ${APP_DIR} && /usr/bin/npm ci --omit=dev`, 300000);

  // Started detached with nohup: a backgrounded command's process would
  // otherwise be torn down with the short-lived shell that launched it, and
  // the log file is the only way to see a startup crash afterwards.
  await run(
    sandbox,
    'start server',
    `cd ${APP_DIR} && (PORT=${APP_PORT} nohup /usr/bin/node server.js > ${APP_DIR}/server.log 2>&1 &) && sleep 3`,
    30000,
  );

  // A process that exits immediately (bad dep, port clash) still looks like a
  // successful launch above, so confirm it actually serves a request.
  const health = await run(sandbox, 'health check', `curl -fsS -o /dev/null -w '%{http_code}' http://localhost:${APP_PORT}/ || (tail -n 40 ${APP_DIR}/server.log; exit 1)`, 30000);

  const sshHost = await setupSsh(sandbox, sudo);

  const host = sandbox.getHost(APP_PORT);
  console.log('\nDeployed.');
  console.log(`  sandbox:  ${SANDBOX_NAME} (${info.sandboxId})`);
  console.log(`  local HTTP status: ${health.stdout.trim()}`);
  console.log(`  URL:      https://${host}`);
  console.log(`  logs:     ${APP_DIR}/server.log`);
  console.log(`  expires:  ${new Date(Date.now() + TIMEOUT_MS).toISOString()}`);
  if (sshHost) {
    // The bit after "user@" is only an SSH host alias (ProxyCommand does the
    // connecting) but it doubles as the known_hosts key, so using the
    // sandboxId keeps each sandbox's host key cached separately instead of
    // tripping a false "HOST IDENTIFICATION HAS CHANGED" on the next deploy.
    const identity = SSH_PUBLIC_KEY_PATH.replace(/\.pub$/, '');
    console.log(`  ssh:      ssh -o 'ProxyCommand=websocat --binary -B 65536 - wss://${sshHost}' -i ${identity} user@${info.sandboxId}`);
  }
}

main().catch((err) => {
  console.error(`\nDeploy failed: ${err.message}`);
  process.exit(1);
});
