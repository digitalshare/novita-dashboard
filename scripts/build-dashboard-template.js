#!/usr/bin/env node
'use strict';

/**
 * Builds a reusable sandbox template carrying everything the dashboard needs,
 * so a deploy from it starts in seconds instead of re-running provisioning.
 *
 * Why a build and not a snapshot of the running sandbox: the obvious way to
 * "save a template for the current instance" is Sandbox.commit(), but this
 * account's domain rejects it outright with "Sandbox.commit is only supported
 * on legacy domains" (confirmed against the live sandbox). Template.build() is
 * the supported path, so the template is DECLARED here rather than captured.
 * The tradeoff is real and worth knowing: this reproduces the deploy's
 * provisioning steps, so it must stay in step with deploy-sandbox.js — it is
 * not a byte-for-byte image of whatever state a sandbox happens to be in.
 *
 * What is deliberately NOT baked in:
 *  - The app's own source. It changes constantly and is uploaded per deploy;
 *    baking it would produce a template that is stale the moment it is built.
 *    Only the slow, stable provisioning goes here.
 *  - Any API key, and the data/ volume contents. A template is a shareable
 *    artifact; a key baked into one leaks with it.
 *  - authorized_keys. SSH keys are per-user, and a key baked into a template
 *    would grant its owner access to every sandbox anyone later spawns from it
 *    — which is exactly why sandboxLib injects keys per-sandbox instead.
 */

const { Template } = require('novita-sandbox');

const API_KEY = process.env.NOVITA_API_KEY;
const ALIAS = process.env.TEMPLATE_ALIAS || 'dashboard-ready';
const WEBSOCAT_VERSION = 'v1.13.0';

async function main() {
  if (!API_KEY) throw new Error('NOVITA_API_KEY is not set.');

  // Node 22 specifically: novita-sandbox's bundle does require("chalk"), and
  // chalk 5 is ESM-only, so the server crashes with ERR_REQUIRE_ESM on the
  // Node 20 that the base image ships. Installing it at build time is the
  // whole point of this template — it is the slowest step of every deploy.
  // Every runCmd needs an explicit `user: 'root'`. Build steps otherwise run
  // as the image's non-root `user`, where apt-get dies with "Could not open
  // lock file /var/lib/dpkg/lock-frontend (13: Permission denied) ... are you
  // root?" and surfaces only as an opaque "exit status 100".
  const asRoot = { user: 'root' };

  const template = Template()
    .fromNodeImage('22-bookworm')
    // curl for the health check and websocat download; iproute2 provides `ss`,
    // which the SSH setup uses to test whether the proxy is already listening.
    .runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates openssh-server iproute2 && rm -rf /var/lib/apt/lists/*', asRoot)
    // Baked in so enabling SSH on a sandbox from this template needs no
    // download at runtime. The binary alone grants nothing without a key.
    .runCmd(`curl -fsSL -o /usr/local/bin/websocat https://github.com/vi/websocat/releases/download/${WEBSOCAT_VERSION}/websocat.$(uname -m)-unknown-linux-musl && chmod +x /usr/local/bin/websocat`, asRoot)
    // sshd refuses to start without its host keys, and generating them at
    // build time keeps first SSH connection fast.
    .runCmd('ssh-keygen -A && mkdir -p /run/sshd', asRoot)
    // Owned by `user` so a deploy can upload the app without needing root.
    .runCmd('mkdir -p /app && chown user:user /app', asRoot)
    .setWorkdir('/app');

  console.log(`Building template "${ALIAS}" (Node 22 + websocat + sshd)...`);
  const started = Date.now();
  const info = await Template.build(template, {
    alias: ALIAS,
    apiKey: API_KEY,
    // Only surface real progress and failures: the raw log stream is very
    // chatty and a failed build's reason is what actually matters.
    onBuildLogs: (entry) => {
      const text = String(entry.message || entry).trim();
      if (text && /error|failed|step|complete/i.test(text)) console.log(`  ${text.slice(0, 160)}`);
    },
  });

  console.log(`\nBuilt in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  alias:      ${info.alias}`);
  console.log(`  templateId: ${info.templateId}`);
  console.log(`  buildId:    ${info.buildId}`);
  console.log(`\nUse it with:  TEMPLATE=${info.alias} node scripts/deploy-sandbox.js`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
