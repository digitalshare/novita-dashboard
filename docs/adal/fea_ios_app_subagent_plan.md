# Novita Resources Manager — iOS App: Subagent Execution Plan

- **Date:** 2026-09-14
- **POC:** Novita Resources Manager (repo: `novita-dashboard`) → native iPhone app
- **Audience:** a coding agent (or a team of parallel subagents) that will generate the app from this plan.

## TL;DR

Build **Novita Manager for iOS**, a native SwiftUI iPhone app (iOS 17+) that mirrors the
existing local web dashboard. The existing app is a Node/Express server (`server.js`, 228 LOC)
that (a) proxies `api.novita.ai` REST calls, (b) wraps the `novita-sandbox` Node SDK for
sandbox/volume lifecycle, (c) runs an OpenAI-compatible tool-calling agent loop, and
(d) bridges an interactive PTY over WebSocket.

The critical architectural fact: **(b), (c) and (d) cannot be reimplemented on-device**, because
`novita-sandbox` is a Node SDK with no Swift equivalent. Therefore the iOS app is split into
two delivery tracks:

- **Track A (device-only, no server):** everything reachable through plain REST on
  `api.novita.ai` — Dashboard, GPU Instances, Serverless Endpoints, Templates, VPC Networks,
  Network Storage, Registry Auth, Billing, API Keys, Accounts (local, Keychain-backed).
- **Track B (companion-server):** Sandboxes, Data Volumes, AI Agent, and the Terminal — these
  talk to the user's existing Node server (`http://<host>:4173`) over its `/api/*` and
  `/ws/terminal` endpoints, reusing the contract documented below verbatim.

Phase 1 ships Track A + read-only Track B. Phase 2 ships Track B writes, the agent chat, and
the terminal.

---

## 1. Ground truth: the existing system

Read these before writing code. Line references are the current state of the repo.

| File | LOC | Role |
|---|---|---|
| `server.js` | 228 | Express routes, credential resolution, generic Novita proxy, WS PTY bridge |
| `lib/sandboxLib.js` | 542 | `novita-sandbox` SDK wrapper: sandbox + volume lifecycle, PTY, Claude Code provisioning |
| `lib/agent.js` | 376 | 13-tool OpenAI-compatible agent loop against Novita chat completions |
| `lib/accounts.js` | 60 | `data/accounts.json` — `{id, label, apiKey, createdAt}` |
| `lib/sandboxNames.js` | 53 | `data/sandbox-names.json` — `{sandboxId: customName}` local alias layer |
| `public/index.html` | 277 | 14 sidebar pages (the screen inventory to port) |
| `public/app.js` | 1545 | All frontend logic; the source of every request shape |

### 1.1 Authentication contract

`server.js:31-47` — `resolveApiKey` accepts **either** header, and every `/api/*` route requires one:

- `x-novita-key: <raw key>` — key held client-side only.
- `x-novita-account: <account id>` — server looks it up in `data/accounts.json`.

For direct Novita calls (Track A), the proxy at `server.js:125-154` shows the real upstream form:
`Authorization: Bearer <apiKey>` + `Content-Type: application/json` against
`https://api.novita.ai/<path>`. **The iOS app in Track A talks to `api.novita.ai` directly with
that Bearer header** — the proxy exists only to defeat browser CORS, which does not apply to a
native app.

Error convention: `/api/*` failures return HTTP 400 (bad/missing credential) or 502
(`{ "error": "<message>" }`) — see `handle()` at `server.js:49-59`. Model this as a single
`NovitaError` type.

### 1.2 Novita REST endpoints actually used (Track A — port all of these)

Extracted from `public/app.js`. Prefix each with `https://api.novita.ai/`.

**Reads**
- `openapi/v1/billing/balance/detail` (dashboard balance; `app.js:211`, `1395`)
- `openapi/v1/billing/bill/list` (`app.js:1456`)
- `openapi/v1/bill/transaction` (`app.js:1483`)
- `openapi/v2/user/key` (API keys; `app.js:1513`)
- `openai/v1/models` (model picker for the agent; `app.js:1297`)
- `gpu-instance/openapi/v1/gpu/instances` (`app.js:287`)
- `gpu-instance/openapi/v1/endpoints` (`app.js:288`)
- `gpu-instance/openapi/v1/templates` (`app.js:289`)
- `gpu-instance/openapi/v1/networks` (`app.js:290`)
- `gpu-instance/openapi/v1/networkstorages/list` (`app.js:270`)
- `gpu-instance/openapi/v1/repository/auths` (`app.js:394`)
- `gpu-instance/openapi/v1/clusters` (`app.js:255`)
- `gpu-instance/openapi/v1/products` (`app.js:263`)
- `gpu-instance/openapi/v1/endpoint/limit` (`app.js:516`)

**Writes**
- `gpu-instance/openapi/v1/gpu/instance/create` (`app.js:458`)
- `gpu-instance/openapi/v1/endpoint/create` (`app.js:608`), `endpoint/delete` (`app.js:500`)
- `gpu-instance/openapi/v1/template/create` (`app.js:703`), `template/delete` (`app.js:646`)
- `gpu-instance/openapi/v1/network/create` (`781`), `network/update` (`760`), `network/delete` (`745`)
- `gpu-instance/openapi/v1/networkstorage/create` (`861`), `networkstorage/update` (`838`), `networkstorage/delete` (`822`)
- `gpu-instance/openapi/v1/repository/auth/save` (`916`), `repository/auth/delete` (`899`)
- GPU instance start/stop/delete actions — read `handleInstanceAction` (`app.js:372-387`) for exact paths.

> **Instruction to the implementing agent:** do not invent request/response shapes. For each
> endpoint above, open the corresponding `public/app.js` function and copy the exact query
> parameters, body keys and response field names into the Swift `Codable` models.

### 1.3 Companion-server endpoints (Track B — proxy through the Node server)

From `server.js:62-120`:

- Accounts: `GET/POST /api/accounts`, `DELETE /api/accounts/:id`
- Sandboxes: `GET /api/sandbox/list?state=a,b`, `POST /api/sandbox/create`,
  `GET /api/sandbox/:id`, and `POST /api/sandbox/:id/{rename,kill,pause,resume,setup-claude-code,mount-volume,unmount-volume}`,
  `GET /api/sandbox/:id/{metrics,ssh-command}`
- Volumes: `GET /api/volume/list`, `POST /api/volume/create`, `DELETE /api/volume/:id`
- Agent: `POST /api/agent/chat` with `{ model, messages }` → runs `runAgentTurn` (`lib/agent.js:315`)
- Terminal: `POST /api/sandbox/:id/terminal-ticket` → `{ ticket }`, then
  `ws://<host>/ws/terminal?ticket=<t>&cols=<n>&rows=<n>`

### 1.4 Terminal protocol (exact — `server.js:102-224`)

1. POST for a ticket using a normal authenticated request. Ticket is **single-use** and expires
   in **30 s**.
2. Open the WebSocket with the ticket in the query string. `cols` is clamped to ≥20, `rows` to ≥10.
3. Frames **to** the server: binary (or non-JSON text) = raw PTY input; JSON
   `{"type":"resize","cols":N,"rows":N}` = resize.
4. Frames **from** the server: binary chunks = PTY output; JSON `{"type":"error","message":...}`
   then close = failure.
5. The server queues early frames until the PTY attaches — the client may write immediately.

### 1.5 Agent contract (`lib/agent.js`)

`POST /api/agent/chat` is **one turn, server-orchestrated**: the server runs the whole
tool-calling loop and returns the assistant message plus the actions it performed. The client is
a thin transcript view — **do not reimplement tool calling on-device**. The 13 tools (for
rendering action chips): `list_sandboxes`, `create_sandbox`, `rename_sandbox`, `kill_sandbox`,
`pause_sandbox`, `resume_sandbox`, `run_command`, `get_sandbox_metrics`,
`setup_claude_code_dev_env`, `list_volumes`, `create_volume`, `delete_volume`, `mount_volume`.
Read `runAgentTurn` (`lib/agent.js:315-375`) and mirror its response JSON exactly; note the 503
"server overload" retry at `lib/agent.js:301-310` — surface it as a retryable error.

---

## 2. Target iOS architecture

- **Language/UI:** Swift 5.9+, SwiftUI, iOS 17.0 minimum. iPhone-only (portrait primary;
  terminal screen also landscape).
- **Concurrency:** `async/await`, `@Observable` view models (Observation framework), no Combine.
- **Networking:** `URLSession` only. No third-party dependency for REST.
- **Persistence:** API keys in **Keychain** (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`),
  never `UserDefaults`. Non-secret prefs (selected account id, server URL, chosen model) in
  `UserDefaults`.
- **Dependencies:** ideally zero. If a terminal emulator is needed, `SwiftTerm` (SPM) is the
  single sanctioned dependency; otherwise implement the read-only log view fallback (§4, W7).
- **Structure:**

```
NovitaManager/
  App/            NovitaManagerApp.swift, RootTabView.swift
  Core/
    Networking/   NovitaClient.swift, CompanionClient.swift, HTTPMethod.swift, NovitaError.swift
    Auth/         KeychainStore.swift, AccountStore.swift, Credential.swift
    Models/       Billing.swift, Instance.swift, Endpoint.swift, Template.swift,
                  Network.swift, Storage.swift, RegistryAuth.swift, Sandbox.swift,
                  Volume.swift, AgentMessage.swift
  Features/
    Dashboard/  Instances/  Endpoints/  Sandboxes/  Volumes/  Agent/
    Templates/  Networks/   Storage/    Registry/   Billing/  Keys/  Accounts/  Settings/
  Shared/       StatusBadge.swift, MoneyFormatter.swift, AsyncStateView.swift,
                Toast.swift, ConfirmDialog.swift, EnvLinesParser.swift
  Terminal/     TerminalViewModel.swift, TerminalSocket.swift, TerminalScreen.swift
Tests/          NovitaManagerTests/, NovitaManagerUITests/
```

- **Navigation:** 5-tab `TabView` — **Dashboard**, **Compute** (Instances, Endpoints,
  Templates), **Sandboxes** (Sandboxes, Volumes, Terminal), **Agent**, **More** (Networks,
  Storage, Registry, Billing, Keys, Accounts, Settings). This replaces the 14-item web sidebar,
  which does not fit a phone.

### 2.1 Non-negotiable rules for every subagent

1. **Never guess an API shape.** Derive it from `public/app.js` / `server.js` / `lib/*.js`.
2. **No secrets in `UserDefaults`, logs, or crash reports.** Redact keys in all error paths.
3. Every list screen handles four states: loading, empty, error (with Retry), loaded.
4. Every destructive action (kill, delete) requires a confirmation dialog — mirrors
   `confirmAction` (`app.js:136`).
5. Do not modify the Node server unless a work item says so (only W9 and W12 may).
6. Write unit tests alongside the code; a work item is not done until its tests pass.

---

## 3. Contract-first: the shared foundation (must land before parallel work)

**W0 — Foundation (blocking, single agent, no parallelism).** Nothing else may start until
this merges, because every other work item imports it.

Deliverables:
- Xcode project (SwiftUI app, iOS 17, iPhone), SPM-ready, no storyboards.
- `NovitaError` — cases: `missingCredential`, `http(status:message:)`, `upstream(message:)`,
  `decoding(underlying:)`, `network(underlying:)`, `retryableOverload`.
- `NovitaClient` — direct `api.novita.ai` client. Injects `Authorization: Bearer`, JSON encode/
  decode, maps non-2xx to `NovitaError`, generic `request<T: Decodable>(path:method:query:body:)`.
- `CompanionClient` — companion-server client. Base URL from Settings; injects `x-novita-key`
  **or** `x-novita-account` per the resolved credential; same error mapping.
- `KeychainStore` + `AccountStore` — add/list/remove/select accounts; the *selected* credential
  is a single source of truth published to all view models.
- `AsyncStateView`, `Toast`, `ConfirmDialog`, `StatusBadge`, `MoneyFormatter`
  (port `money`, `app.js:65`; `unixToLocal`, `app.js:71`).
- `RootTabView` with 5 tabs wired to placeholder screens.

Tests: error mapping for 400/502/malformed JSON; Keychain round-trip; header selection
(`x-novita-key` vs `x-novita-account`); money/date formatting.

**Definition of done:** app builds, launches, shows 5 tabs, an account can be added and
persists across relaunch.

---

## 4. Parallel work items (after W0)

Each is one subagent, one branch, one PR. The **Depends** column is the only ordering constraint.

| ID | Work item | Depends | Track |
|---|---|---|---|
| W1 | Accounts + Settings + onboarding | W0 | A |
| W2 | Dashboard | W0 | A |
| W3 | GPU Instances (list, detail, create, actions) | W0 | A |
| W4 | Serverless Endpoints | W0 | A |
| W5 | Templates + Registry Auth | W0 | A |
| W6 | VPC Networks + Network Storage | W0 | A |
| W7 | Billing + API Keys | W0 | A |
| W8 | Sandboxes (list, detail, lifecycle, rename) | W0 | B |
| W9 | Data Volumes + mount/unmount | W0 | B |
| W10 | AI Agent chat | W0, W7 (model list) | B |
| W11 | Terminal (WebSocket PTY) | W8 | B |
| W12 | Push-free background refresh + polling policy | W2, W3, W8 | A/B |
| W13 | Accessibility, Dark Mode, iPad-safe layout pass | W1–W11 | — |
| W14 | Test hardening + CI + TestFlight packaging | W1–W13 | — |

### W1 — Accounts, Settings, onboarding
Port `loadAccounts` (`app.js:1340`) and the Settings page (`index.html:252`).
Screens: Accounts list (label + masked key + created date, swipe-to-delete, tap-to-select),
Add Account sheet, Settings (companion server URL with reachability check, selected model,
"paste key for this session only" option mirroring the web `sessionStorage` behaviour).
First-run onboarding: explain the two credential modes and that Sandboxes/Agent/Terminal need
the companion server.
**Critical:** account CRUD may go to `/api/accounts` on the companion server *or* stay purely
local on-device. Implement **local-first** (Keychain) as the default so Track A works with no
server at all, and offer "sync with companion server" as an explicit toggle.

### W2 — Dashboard
Port `loadDashboard` (`app.js:279-325`). Balance card from
`openapi/v1/billing/balance/detail`, plus counts from `gpu/instances`, `endpoints`, `templates`,
`networks`, and (when a companion server is configured) sandboxes/volumes. Fetch concurrently
with `async let`/`TaskGroup`; a single failing count degrades that card only, never the screen.
Pull-to-refresh.

### W3 — GPU Instances
Port `loadInstances` (`331`), `handleInstanceAction` (`372`), `openCreateInstanceModal` (`388-469`).
List with status badges (`statusBadge`, `app.js:326`); detail view; create form driven by
`clusters` (`255`) + `products` (`263`); start/stop/delete with confirmation. The create form is
the most complex in the app — read `openCreateInstanceModal` line by line, including
`parseEnvLines` (`app.js:141`) for env-var entry.

### W4 — Serverless Endpoints
Port `loadEndpoints` (`470`), `openCreateEndpointModal` (`510-619`), delete (`500`), and the
quota display from `endpoint/limit` (`516`).

### W5 — Templates + Registry Auth
Port `loadTemplates` (`620`) + create/delete (`703`, `646`); `loadRegistry` (`873`) +
save/delete (`916`, `899`). Registry credentials are secrets: never log, mask in UI.

### W6 — VPC Networks + Network Storage
Port `loadNetworks` (`715`) with create/update/delete (`781`, `760`, `745`) and `loadStorage`
(`793`) with create/update/delete (`861`, `838`, `822`).

### W7 — Billing + API Keys
Port `loadBilling` (`1425`), `loadUsage` (`1446`), `loadTransactions` (`1477`), `loadKeys` (`1507`).
Also expose the model list (`openai/v1/models`, `1297`) as a reusable `ModelListService` that
W10 consumes. Paginate transactions.

### W8 — Sandboxes
Port `sandboxRow` (`930`), `loadSandboxes` (`954`), `handleSandboxAction` (`973-1148`),
`showUsageModal` (`1149`). All via `CompanionClient`. Actions: create, rename, pause, resume,
kill, metrics, SSH command (offer copy-to-clipboard), `setup-claude-code`.
`setup-claude-code` is long-running — show indeterminate progress and never block the UI.
Show a clear "companion server not configured / unreachable" empty state instead of an error.

### W9 — Data Volumes
Port `loadVolumes` (`1175`) plus create/delete and sandbox mount/unmount.

### W10 — AI Agent chat
Port `renderAgentChat` (`1262`), `renderAgentActions` (`1281`), `loadAgentPage` (`1292`).
Chat transcript, model picker (from W7), message composer, action chips per executed tool.
`POST /api/agent/chat` with the accumulated `messages` array; the response's messages are
appended to local state. Surface the overload retry as a non-fatal "model busy, retrying" state.
Persist the transcript for the session only.
**Optional server change (must be proposed to the user first, not done unilaterally):** the
current endpoint is non-streaming, so a long turn shows nothing until it completes. If streaming
is wanted, that is a separate server work item — do not silently change `/api/agent/chat`.

### W11 — Terminal
Implement §1.4 exactly. `URLSessionWebSocketTask`. Ticket fetch → socket open must happen inside
the 30 s window; on 401, re-fetch a ticket once. Send resize on rotation and on keyboard
show/hide. Ship a custom accessory key row (Tab, Ctrl, Esc, arrows, `|`, `/`, `-`) because iOS
keyboards lack them. Use `SwiftTerm` if ANSI fidelity is required; otherwise a monospaced
scroll-back view that strips ANSI escapes, with the limitation documented in the PR.

### W12 — Refresh policy
Foreground polling with backoff (instances/sandboxes 15 s while visible, paused when
backgrounded), `.refreshable` everywhere, request coalescing, cancel in-flight work on tab
switch. No silent battery drain: nothing polls in the background.

### W13 — Polish
Dynamic Type, VoiceOver labels on every action button, contrast-checked status colours, Dark
Mode, safe-area handling for the terminal, haptics on destructive confirm.

### W14 — Hardening & release
Unit tests ≥70 % on `Core/`; snapshot or UI tests for the four screen states; mocked
`URLProtocol` for all network tests; a fake WebSocket server for W11. GitHub Actions running
`xcodebuild test` on an iPhone simulator. Fastlane or `xcodebuild -exportArchive` for TestFlight;
document required Info.plist entries (App Transport Security exception for a plaintext
`http://` LAN companion server — `NSAllowsLocalNetworking`, not a blanket
`NSAllowsArbitraryLoads`) and the local-network usage description.

---

## 5. Execution schedule

- **Wave 0 (serial):** W0. Everything blocks on it.
- **Wave 1 (parallel, up to 7 agents):** W1, W2, W3, W4, W5, W6, W7.
- **Wave 2 (parallel, up to 3 agents):** W8, W9, W10.
- **Wave 3:** W11 (needs W8), W12.
- **Wave 4 (serial):** W13, then W14.

Merge discipline: each agent branches from the latest `main`, touches only its own
`Features/<Area>/` directory plus additive changes to `Core/`, and rebases before opening a PR.
Two agents must never edit the same file — if a shared change is needed in `Core/`, it belongs
in W0 or in a follow-up.

---

## 6. Risks and decisions

| Risk | Impact | Mitigation |
|---|---|---|
| `novita-sandbox` is Node-only | Sandboxes/Agent/Terminal cannot be device-native | Companion-server model (Track B); Track A ships standalone value with no server |
| Companion server is `http://` on a LAN | ATS blocks it by default; key travels in cleartext | `NSAllowsLocalNetworking`; warn in Settings; recommend HTTPS/tailnet for non-LAN use |
| API key on a mobile device | Loss of device = loss of key | Keychain `WhenUnlockedThisDeviceOnly` + optional Face ID gate before revealing/using a key |
| Undocumented Novita response shapes | Decoding crashes | Derive from `app.js`; make every non-essential field optional; never force-unwrap |
| 14 web pages on a phone | Unusable navigation | 5-tab IA with a "More" list |
| Non-streaming agent endpoint | Long silent waits | Progress state now; propose streaming as a separate, user-approved server change |
| Terminal fidelity | Broken TUI apps (vim, htop) | `SwiftTerm`, or document the plain-text fallback's limits |

## 7. Definition of done (whole project)

1. Track A works with **only** an API key — no companion server running.
2. Track B degrades to a clear, actionable empty state when no server is configured.
3. All 14 web pages are reachable in the iOS IA, with feature parity or an explicitly documented gap.
4. No secret is ever written outside the Keychain.
5. `xcodebuild test` is green in CI; a TestFlight build installs and runs on a physical iPhone.
