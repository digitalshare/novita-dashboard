'use strict';

const sandboxLib = require('./sandboxLib');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_sandboxes',
      description: 'List the Novita sandboxes on this account, optionally filtered by state.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'array',
            items: { type: 'string', enum: ['running', 'paused'] },
            description: 'Only return sandboxes in these states. Omit to return both.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_sandbox',
      description: 'Create a new Novita sandbox (an isolated execution environment for running code/commands).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short memorable name to give this sandbox (e.g. "scraper-box"), so it can be referred to by name instead of its opaque ID afterward. Must be unique.' },
          template: { type: 'string', description: 'Template name or ID to base the sandbox on. Omit for the default base template.' },
          timeoutMinutes: { type: 'number', description: 'Max lifetime in minutes before the sandbox auto-stops. Default 10.' },
          metadata: { type: 'object', description: 'Arbitrary string key/value tags to attach, e.g. {"purpose":"demo"}.' },
          envs: { type: 'object', description: 'Environment variables to set inside the sandbox.' },
          allowInternetAccess: { type: 'boolean', description: 'Whether the sandbox can reach the internet. Default true.' },
          volumeMounts: {
            type: 'array',
            description: 'Persistent Volumes to mount at creation, so files under the mount path survive even after this sandbox is killed and a new one is made. Use an existing volume name (see list_volumes) or a new one — create_volume makes it if it does not exist yet, but you can also just reference a name here directly.',
            items: {
              type: 'object',
              properties: {
                volumeName: { type: 'string' },
                mountPath: { type: 'string', description: 'Absolute path inside the sandbox, e.g. "/home/user/data".' },
              },
              required: ['volumeName', 'mountPath'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_sandbox',
      description: 'Give a sandbox a new name. Novita has no rename API for sandboxes, so this is tracked in this app\'s own local storage and always takes precedence over the name given at creation.',
      parameters: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'The sandbox\'s current name, or its raw sandbox ID.' },
          name: { type: 'string', description: 'The new name. Must be unique.' },
        },
        required: ['sandboxId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_sandbox',
      description: 'Permanently terminate a sandbox and free its resources. Cannot be undone.',
      parameters: {
        type: 'object',
        properties: { sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' } },
        required: ['sandboxId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_sandbox',
      description: 'Pause a running sandbox. Filesystem and memory state are preserved; billing for compute stops.',
      parameters: {
        type: 'object',
        properties: { sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' } },
        required: ['sandboxId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_sandbox',
      description: 'Resume a paused sandbox back to the running state.',
      parameters: {
        type: 'object',
        properties: { sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' } },
        required: ['sandboxId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command inside a running sandbox and return its output.',
      parameters: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' },
          cmd: { type: 'string', description: 'The shell command to execute.' },
          background: { type: 'boolean', description: 'Run without waiting for it to finish (e.g. starting a server). Default false.' },
        },
        required: ['sandboxId', 'cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sandbox_metrics',
      description: 'Check a sandbox\'s CPU, memory, and disk usage.',
      parameters: {
        type: 'object',
        properties: { sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' } },
        required: ['sandboxId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setup_claude_code_dev_env',
      description: 'Turn a sandbox into a web-dev environment for an AI coding agent: installs the Claude Code CLI and a headless Chromium via Playwright, and actually verifies it launches (not just that the files exist). This is how Claude Code can develop AND test a web app inside a sandbox with no display — it drives the headless browser directly (click, fill forms, read the DOM, screenshot) instead of needing a real screen. Works on any template; takes 1-2 minutes on a plain "base" template while the browser downloads, faster on one that already has it cached.',
      parameters: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' },
          anthropicApiKey: { type: 'string', description: 'An Anthropic API key for Claude Code to bill against. Either this or claudeCodeOauthToken is required for Claude Code to actually run tasks (claude -p "...") without prompting — ask the user for one if neither is supplied.' },
          claudeCodeOauthToken: { type: 'string', description: 'A Claude Pro/Max/Team/Enterprise subscription token from running `claude setup-token` interactively elsewhere (this cannot be generated from inside a headless sandbox — it needs a real browser). Use this instead of anthropicApiKey if the user wants to bill against their subscription rather than API usage.' },
        },
        required: ['sandboxId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_volumes',
      description: 'List persistent Volumes on this account. Unlike a sandbox\'s own disk, a Volume survives independently and can be mounted into a new sandbox later with its data intact.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_volume',
      description: 'Create a new persistent Volume for storing data that should survive sandbox recreation.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A unique name for the volume, e.g. "dashboard-data".' },
          quotaSizeGiB: { type: 'number', description: 'Storage quota in GiB. Default 1.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_volume',
      description: 'Permanently delete a persistent Volume and all its data. Cannot be undone.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The volume\'s name or ID.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mount_volume',
      description: 'Mount an existing persistent Volume into an already-running sandbox at a given path.',
      parameters: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'The sandbox name given at creation, or its raw sandbox ID.' },
          volumeName: { type: 'string' },
          mountPath: { type: 'string', description: 'Absolute path inside the sandbox, e.g. "/home/user/data".' },
        },
        required: ['sandboxId', 'volumeName', 'mountPath'],
      },
    },
  },
];

// Models don't always serialize booleans as real JSON booleans (one
// returned the literal string "false" for run_command's `background`,
// which `!!"false"` reads as true — any non-empty string is truthy).
// Every boolean-typed tool argument goes through this rather than a raw
// truthiness check.
function toBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

async function executeTool(apiKey, name, args) {
  switch (name) {
    case 'list_sandboxes':
      return { sandboxes: await sandboxLib.listSandboxes(apiKey, { state: args.state }) };
    case 'create_sandbox':
      return await sandboxLib.createSandbox(apiKey, {
        name: args.name,
        template: args.template,
        timeoutMs: args.timeoutMinutes ? Math.round(args.timeoutMinutes * 60000) : undefined,
        metadata: args.metadata,
        envs: args.envs,
        allowInternetAccess: toBool(args.allowInternetAccess, true),
        volumeMounts: args.volumeMounts,
      });
    case 'rename_sandbox':
      return await sandboxLib.renameSandbox(apiKey, args.sandboxId, args.name);
    case 'kill_sandbox':
      return await sandboxLib.killSandbox(apiKey, args.sandboxId);
    case 'pause_sandbox':
      return await sandboxLib.pauseSandbox(apiKey, args.sandboxId);
    case 'resume_sandbox':
      return await sandboxLib.resumeSandbox(apiKey, args.sandboxId);
    case 'run_command':
      return await sandboxLib.runCommand(apiKey, args.sandboxId, args.cmd, { background: toBool(args.background, false) });
    case 'get_sandbox_metrics':
      return { metrics: await sandboxLib.getSandboxMetrics(apiKey, args.sandboxId) };
    case 'setup_claude_code_dev_env':
      return await sandboxLib.setupClaudeCodeDevEnv(apiKey, args.sandboxId, { anthropicApiKey: args.anthropicApiKey, claudeCodeOauthToken: args.claudeCodeOauthToken });
    case 'list_volumes':
      return { volumes: await sandboxLib.listVolumes(apiKey) };
    case 'create_volume':
      return await sandboxLib.createVolume(apiKey, args.name, args.quotaSizeGiB);
    case 'delete_volume':
      return await sandboxLib.deleteVolume(apiKey, args.name);
    case 'mount_volume':
      return await sandboxLib.mountVolume(apiKey, args.sandboxId, args.volumeName, args.mountPath);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const SYSTEM_PROMPT = `You are the built-in infrastructure assistant for a Novita AI resource dashboard.
You can create, list, pause, resume, and kill Novita Sandboxes, run shell commands inside them, and check
their CPU/memory/disk usage. Sandbox IDs are opaque and hard to remember, so give new sandboxes a short name
when the user doesn't specify one, and always refer to sandboxes by name afterward. A sandbox's own disk is
wiped when it's killed or times out — anything that needs to survive that (saved data, generated files)
belongs on a persistent Volume instead: create one, mount it into the sandbox at creation (create_sandbox's
volumeMounts) or afterward (mount_volume), and reuse the same volume name on future sandboxes to pick the
data back up. If the user wants to develop or test a web app with Claude Code inside a sandbox, use
setup_claude_code_dev_env — it installs the Claude Code CLI plus a headless Chromium (via Playwright) so
Claude Code can build AND test the app with no display server at all, driving the browser programmatically
(click, fill forms, screenshot) rather than needing a real screen; ask for an anthropicApiKey (or a
claudeCodeOauthToken, if the user already has one from running "claude setup-token" elsewhere — that step
itself needs a real browser and can't be done from inside the sandbox) since Claude Code can't run tasks
without one. setup_claude_code_dev_env's result includes the exact chromium.launch() args required in this
environment — pass those along whenever telling Claude Code (or writing code yourself) how to drive the
browser there; plain chromium.launch() with no args reliably crashes with a V8 virtual-memory error on this
platform. Use the provided tools to take action rather than just describing what the user should do.
Confirm destructive actions (kill_sandbox, delete_volume) are what the user intended based on their message
before calling them. Be concise in your replies.`;

async function callModelOnce(apiKey, model, messages, toolChoice) {
  const body = { model, messages, temperature: 0.3 };
  if (toolChoice !== 'none') {
    body.tools = TOOLS;
    body.tool_choice = toolChoice;
  }
  const res = await fetch('https://api.novita.ai/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const message = data?.message || data?.error?.message || `Model request failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.retryable = /overload/i.test(message) || res.status === 503;
    throw err;
  }
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('The model returned no response.');
  return msg;
}

// Novita's chat completions endpoint occasionally returns a transient
// "server overload" error under load — worth one quiet retry before
// surfacing it as a real failure.
async function callModel(apiKey, model, messages, { toolChoice = 'auto' } = {}) {
  try {
    return await callModelOnce(apiKey, model, messages, toolChoice);
  } catch (err) {
    if (!err.retryable) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return callModelOnce(apiKey, model, messages, toolChoice);
  }
}

function callSignature(call) {
  return `${call.function?.name}(${call.function?.arguments || ''})`;
}

async function runAgentTurn(apiKey, model, incomingMessages) {
  if (!apiKey) throw new Error('Missing Novita API key.');
  if (!model) throw new Error('No model selected.');

  const hasSystem = incomingMessages.some((m) => m.role === 'system');
  const workingMessages = hasSystem ? [...incomingMessages] : [{ role: 'system', content: SYSTEM_PROMPT }, ...incomingMessages];
  const actions = [];
  const MAX_STEPS = 6;
  let lastSignature = null;
  let stuck = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await callModel(apiKey, model, workingMessages);
    workingMessages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return { messages: workingMessages, actions };
    }

    // Some models keep re-issuing an identical call instead of concluding
    // once they see the result. Break out and force a text summary instead
    // of burning the whole step budget on repeats.
    const signature = toolCalls.map(callSignature).join('|');
    if (signature === lastSignature) {
      stuck = true;
      break;
    }
    lastSignature = signature;

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* leave empty */ }
      let result;
      try {
        result = await executeTool(apiKey, name, args);
      } catch (err) {
        result = { error: err.message };
      }
      actions.push({ tool: name, args, result });
      workingMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Ran out of steps (or detected a repeat loop) without a final text reply
  // — ask once more with tools disabled so the user gets a real answer
  // instead of a silent truncation.
  try {
    const finalMsg = await callModel(apiKey, model, workingMessages, { toolChoice: 'none' });
    workingMessages.push(finalMsg);
    return { messages: workingMessages, actions };
  } catch {
    return { messages: workingMessages, actions, truncated: true };
  }
}

module.exports = { runAgentTurn, TOOLS };
