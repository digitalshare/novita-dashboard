'use strict';

/* ---------------------------------------------------------------------- */
/* State & low-level helpers                                              */
/* ---------------------------------------------------------------------- */

let API_KEY = sessionStorage.getItem('novita_api_key') || '';
let ACTIVE_ACCOUNT_ID = localStorage.getItem('novita_active_account') || '';
const cache = { clusters: null, products: null, storages: null, accounts: [] };

function qs(obj) {
  const parts = Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function authHeaders() {
  if (ACTIVE_ACCOUNT_ID) return { 'x-novita-account': ACTIVE_ACCOUNT_ID };
  if (API_KEY) return { 'x-novita-key': API_KEY };
  return {};
}

function hasAuth() {
  return Boolean(ACTIVE_ACCOUNT_ID || API_KEY);
}

async function apiRaw(url, { method = 'GET', body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.reason || data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function api(path, { method = 'GET', query, body } = {}) {
  if (!hasAuth()) {
    throw new Error('No API key set. Pick an account in the sidebar, or paste a key in Settings.');
  }
  return apiRaw(`/api/proxy/${path}${qs(query)}`, { method, body, headers: authHeaders() });
}

/* Non-proxy backend endpoints (sandboxes, agent, accounts) — same auth headers. */
async function local(path, { method = 'GET', body } = {}) {
  if (!hasAuth() && !path.startsWith('/api/accounts')) {
    throw new Error('No API key set. Pick an account in the sidebar, or paste a key in Settings.');
  }
  return apiRaw(path, { method, body, headers: authHeaders() });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return '$0.00';
  return `$${(n / 10000).toFixed(2)}`;
}

function unixToLocal(ts) {
  const n = Number(ts);
  if (!n) return '—';
  return new Date(n * 1000).toLocaleString();
}

function toast(message, type = 'info') {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

async function withBusy(btn, fn) {
  setBusy(btn, true);
  try { await fn(); }
  catch (err) { toast(err.message, 'error'); }
  finally { setBusy(btn, false); }
}

/* ---------------------------------------------------------------------- */
/* Modal helper                                                           */
/* ---------------------------------------------------------------------- */

function openModal({ title, subtitle, bodyHtml, submitLabel = 'Save', onSubmit, wide = false }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" style="${wide ? 'max-width:760px;' : ''}">
        <h3>${escapeHtml(title)}</h3>
        ${subtitle ? `<div class="modal-sub">${escapeHtml(subtitle)}</div>` : ''}
        <form id="modal-form">${bodyHtml}</form>
        <div class="modal-actions">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" form="modal-form" class="btn btn-primary" id="modal-submit">${escapeHtml(submitLabel)}</button>
        </div>
      </div>
    </div>`;
  const backdrop = document.getElementById('modal-backdrop');
  const close = () => { root.innerHTML = ''; };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.getElementById('modal-cancel').addEventListener('click', close);
  document.getElementById('modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('modal-submit');
    setBusy(submitBtn, true);
    try {
      await onSubmit(new FormData(e.target), close);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(submitBtn, false);
    }
  });
  return close;
}

function confirmAction(message) {
  return window.confirm(message);
}

/* Parse "KEY=value" per line into [{key,value}] */
function parseEnvLines(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf('=');
      return idx === -1 ? { key: l, value: '' } : { key: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() };
    });
}

/* ---------------------------------------------------------------------- */
/* Navigation                                                             */
/* ---------------------------------------------------------------------- */

const loaders = {
  dashboard: loadDashboard,
  instances: loadInstances,
  endpoints: loadEndpoints,
  sandboxes: loadSandboxes,
  volumes: loadVolumes,
  agent: loadAgentPage,
  templates: loadTemplates,
  networks: loadNetworks,
  storage: loadStorage,
  registry: loadRegistry,
  billing: loadBilling,
  keys: loadKeys,
  accounts: loadAccounts,
  settings: async () => {},
};

function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.hidden = true);
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.getElementById(`page-${name}`).hidden = false;
  const fn = loaders[name];
  if (fn) fn().catch((err) => toast(err.message, 'error'));
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

document.querySelectorAll('[data-refresh]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.refresh;
    if (page === 'instances') cache.products = null;
    (loaders[page] || (() => {}))().catch((err) => toast(err.message, 'error'));
  });
});

/* ---------------------------------------------------------------------- */
/* Settings                                                               */
/* ---------------------------------------------------------------------- */

const connDot = document.getElementById('conn-dot');
const keyStatus = document.getElementById('key-status');
document.getElementById('settings-api-key').value = API_KEY;

document.getElementById('btn-save-key').addEventListener('click', async () => {
  const val = document.getElementById('settings-api-key').value.trim();
  const btn = document.getElementById('btn-save-key');
  API_KEY = val;
  sessionStorage.setItem('novita_api_key', val);
  ACTIVE_ACCOUNT_ID = '';
  localStorage.removeItem('novita_active_account');
  document.getElementById('account-switcher').value = '';
  await withBusy(btn, async () => {
    if (!val) throw new Error('Enter an API key first.');
    await api('openapi/v1/billing/balance/detail');
    connDot.classList.add('connected');
    keyStatus.textContent = 'Connected';
    keyStatus.style.color = 'var(--ok)';
    toast('Connected to Novita.', 'success');
    loadDashboard().catch(() => {});
  });
});

/* ---------------------------------------------------------------------- */
/* Account switcher (sidebar)                                             */
/* ---------------------------------------------------------------------- */

const accountSwitcher = document.getElementById('account-switcher');

async function refreshAccountSwitcher() {
  try {
    const data = await apiRaw('/api/accounts');
    cache.accounts = data.accounts || [];
  } catch {
    cache.accounts = [];
  }
  const current = accountSwitcher.value;
  accountSwitcher.innerHTML = `<option value="">Session key (Settings)</option>` +
    cache.accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)} (${escapeHtml(a.maskedKey)})</option>`).join('');
  accountSwitcher.value = cache.accounts.some((a) => a.id === current) ? current : (ACTIVE_ACCOUNT_ID || '');
}

accountSwitcher.addEventListener('change', () => {
  ACTIVE_ACCOUNT_ID = accountSwitcher.value;
  if (ACTIVE_ACCOUNT_ID) localStorage.setItem('novita_active_account', ACTIVE_ACCOUNT_ID);
  else localStorage.removeItem('novita_active_account');
  connDot.classList.remove('connected');
  const activePage = document.querySelector('.nav-btn.active')?.dataset.page || 'dashboard';
  showPage(activePage);
  api('openapi/v1/billing/balance/detail').then(() => connDot.classList.add('connected')).catch(() => {});
});

/* ---------------------------------------------------------------------- */
/* Shared lookups                                                         */
/* ---------------------------------------------------------------------- */

async function getClusters() {
  if (!cache.clusters) {
    const data = await api('gpu-instance/openapi/v1/clusters');
    cache.clusters = data.data || [];
  }
  return cache.clusters;
}

async function getProducts() {
  if (!cache.products) {
    const data = await api('gpu-instance/openapi/v1/products');
    cache.products = data.data || [];
  }
  return cache.products;
}

async function getStorages() {
  const data = await api('gpu-instance/openapi/v1/networkstorages/list', { query: { pageNo: 1, pageSize: 200 } });
  cache.storages = data.data || [];
  return cache.storages;
}

/* ---------------------------------------------------------------------- */
/* Dashboard                                                              */
/* ---------------------------------------------------------------------- */

async function loadDashboard() {
  const balanceEl = document.getElementById('balance-stats');
  const resourceEl = document.getElementById('resource-stats');
  balanceEl.innerHTML = '<div class="stat-card">Loading…</div>';
  resourceEl.innerHTML = '';

  const [balance, instances, endpoints, templates, networks, storages] = await Promise.allSettled([
    api('openapi/v1/billing/balance/detail'),
    api('gpu-instance/openapi/v1/gpu/instances', { query: { pageSize: 1, pageNum: 0 } }),
    api('gpu-instance/openapi/v1/endpoints', { query: { pageSize: 1, pageNum: 0 } }),
    api('gpu-instance/openapi/v1/templates', { query: { channel: 'private', isMyCommunity: true, pageSize: 1, pageNum: 0 } }),
    api('gpu-instance/openapi/v1/networks', { query: { pageSize: 1, pageNum: 0 } }),
    api('gpu-instance/openapi/v1/networkstorages/list', { query: { pageNo: 1, pageSize: 1 } }),
  ]);

  if (balance.status === 'fulfilled') {
    connDot.classList.add('connected');
    const b = balance.value;
    balanceEl.innerHTML = [
      ['Available balance', money(b.availableBalance)],
      ['Cash balance', money(b.cashBalance)],
      ['Credit limit', money(b.creditLimit)],
      ['Outstanding invoices', money(b.outstandingInvoices)],
    ].map(([label, val]) => `<div class="stat-card"><div class="label">${label}</div><div class="value">${val}</div></div>`).join('');
  } else {
    balanceEl.innerHTML = `<div class="stat-card"><div class="label">Balance</div><div class="value">—</div></div>`;
    toast(balance.reason.message, 'error');
  }

  const stat = (label, result) => `<div class="stat-card"><div class="label">${label}</div><div class="value">${result.status === 'fulfilled' ? (result.value.total ?? '—') : '—'}</div></div>`;
  resourceEl.innerHTML = [
    stat('GPU Instances', instances),
    stat('Serverless Endpoints', endpoints),
    stat('Templates', templates),
    stat('VPC Networks', networks),
    stat('Network Storage Volumes', storages),
  ].join('');
}

/* ---------------------------------------------------------------------- */
/* GPU Instances                                                          */
/* ---------------------------------------------------------------------- */

const INSTANCE_STATUS_BADGE = {
  running: 'ok', exited: 'warn', removed: 'danger',
};

function statusBadge(status) {
  const cls = INSTANCE_STATUS_BADGE[status] || (status?.includes('ing') || status?.startsWith('to') ? '' : '');
  return `<span class="badge ${cls}">${escapeHtml(status || 'unknown')}</span>`;
}

async function loadInstances() {
  const table = document.getElementById('tbl-instances');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>Status</th><th>Product</th><th>GPUs</th><th>CPU</th><th>Mem (GB)</th><th>Billing</th><th>Ends</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/gpu/instances', { query: { pageSize: 200, pageNum: 0 } });
  const instances = data.instances || [];
  if (!instances.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No instances yet. Click "New Instance" to create one.</td></tr>`;
    return;
  }

  tbody.innerHTML = instances.map((inst) => {
    const canStart = inst.status === 'exited';
    const canStop = inst.status === 'running';
    const canRestart = inst.status === 'running';
    const canDelete = ['exited', 'running'].includes(inst.status);
    return `<tr data-id="${escapeHtml(inst.id)}">
      <td>${escapeHtml(inst.name || inst.id)}<div class="hint mono">${escapeHtml(inst.id)}</div></td>
      <td>${statusBadge(inst.status)}</td>
      <td>${escapeHtml(inst.productName || '—')}</td>
      <td>${escapeHtml(inst.gpuNum ?? '—')}</td>
      <td>${escapeHtml(inst.cpuNum ?? '—')}</td>
      <td>${escapeHtml(inst.memory ?? '—')}</td>
      <td>${escapeHtml(inst.billingMode || '—')}</td>
      <td>${inst.endTime && inst.endTime !== '-1' ? unixToLocal(inst.endTime) : '—'}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="start" ${canStart ? '' : 'disabled'}>Start</button>
        <button class="btn btn-sm" data-act="stop" ${canStop ? '' : 'disabled'}>Stop</button>
        <button class="btn btn-sm" data-act="restart" ${canRestart ? '' : 'disabled'}>Restart</button>
        <button class="btn btn-sm btn-danger" data-act="delete" ${canDelete ? '' : 'disabled'}>Delete</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleInstanceAction(btn));
  });
}

async function handleInstanceAction(btn) {
  const tr = btn.closest('tr');
  const id = tr.dataset.id;
  const act = btn.dataset.act;
  const pathMap = { start: 'start', stop: 'stop', restart: 'restart', delete: 'delete' };
  if (act === 'delete' && !confirmAction('Delete this instance? This permanently destroys its disk. This cannot be undone.')) return;
  if (act === 'stop' && !confirmAction('Stop this instance?')) return;
  await withBusy(btn, async () => {
    await api(`gpu-instance/openapi/v1/gpu/instance/${pathMap[act]}`, { method: 'POST', body: { instanceId: id } });
    toast(`Instance ${act} requested.`, 'success');
    await loadInstances();
  });
}

document.getElementById('btn-new-instance').addEventListener('click', openCreateInstanceModal);

async function openCreateInstanceModal() {
  let clusters = [], products = [], registries = [];
  try {
    [clusters, products, registries] = await Promise.all([
      getClusters(),
      getProducts(),
      api('gpu-instance/openapi/v1/repository/auths').then((d) => d.data || []).catch(() => []),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }

  const productOpts = products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} — ${money(p.price)}/hr (${p.availableDeploy ? p.inventoryState || 'available' : 'unavailable'})</option>`).join('');
  const clusterOpts = `<option value="">Any (random)</option>` + clusters.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  const authOpts = `<option value="">None</option>` + registries.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');

  const bodyHtml = `
    <div class="field"><label>Instance name</label><input name="name" placeholder="my-instance" /></div>
    <div class="field-row">
      <div class="field"><label>Kind</label><select name="kind"><option value="gpu">GPU</option><option value="cpu">CPU</option></select></div>
      <div class="field"><label>GPU product</label><select name="productId" required>${productOpts}</select></div>
    </div>
    <div class="field-row-3">
      <div class="field"><label>GPU count</label><input type="number" name="gpuNum" min="1" max="8" value="1" /></div>
      <div class="field"><label>Root disk (GB)</label><input type="number" name="rootfsSize" min="10" max="6144" value="20" /></div>
      <div class="field"><label>Cluster</label><select name="clusterId">${clusterOpts}</select></div>
    </div>
    <div class="field"><label>Image URL</label><input name="imageUrl" required placeholder="docker.io/library/ubuntu:latest" /></div>
    <div class="field-row">
      <div class="field"><label>Registry auth (private images)</label><select name="imageAuthId">${authOpts}</select></div>
      <div class="field"><label>Ports (e.g. 8080/http,22/tcp)</label><input name="ports" placeholder="8080/http,22/tcp" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Command (optional)</label><input name="command" /></div>
      <div class="field"><label>Entrypoint (optional)</label><input name="entrypoint" /></div>
    </div>
    <div class="field"><label>Environment variables (KEY=value, one per line)</label><textarea name="envs" placeholder="MY_VAR=hello"></textarea></div>
    <fieldset>
      <legend>Billing</legend>
      <div class="field-row-3">
        <div class="field"><label>Billing mode</label><select name="billingMode"><option value="onDemand">On-demand</option><option value="monthly">Monthly</option><option value="spot">Spot</option></select></div>
        <div class="field"><label>Months (0 = pay-as-you-go)</label><input type="number" name="month" min="0" value="0" /></div>
        <div class="field"><label>Min CUDA version (optional)</label><input name="minCudaVersion" placeholder="11.8" /></div>
      </div>
    </fieldset>
  `;

  openModal({
    title: 'New GPU Instance',
    subtitle: 'Provisions a new instance on Novita. This will incur charges.',
    bodyHtml,
    submitLabel: 'Create Instance',
    wide: true,
    onSubmit: async (fd, close) => {
      const payload = {
        name: fd.get('name') || undefined,
        kind: fd.get('kind'),
        productId: fd.get('productId'),
        gpuNum: Number(fd.get('gpuNum')) || 1,
        rootfsSize: Number(fd.get('rootfsSize')) || 20,
        imageUrl: fd.get('imageUrl'),
        imageAuthId: fd.get('imageAuthId') || undefined,
        ports: fd.get('ports') || undefined,
        command: fd.get('command') || undefined,
        entrypoint: fd.get('entrypoint') || undefined,
        clusterId: fd.get('clusterId') || undefined,
        billingMode: fd.get('billingMode'),
        month: Number(fd.get('month')) || 0,
        minCudaVersion: fd.get('minCudaVersion') || undefined,
      };
      const envs = parseEnvLines(fd.get('envs'));
      if (envs.length) payload.envs = envs;
      const res = await api('gpu-instance/openapi/v1/gpu/instance/create', { method: 'POST', body: payload });
      toast(`Instance created: ${res.id}`, 'success');
      close();
      await loadInstances();
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Serverless Endpoints                                                   */
/* ---------------------------------------------------------------------- */

async function loadEndpoints() {
  const table = document.getElementById('tbl-endpoints');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>State</th><th>URL</th><th>Workers (min-max)</th><th>GPU/worker</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/endpoints', { query: { pageSize: 200, pageNum: 0 } });
  const endpoints = data.endpoints || [];
  if (!endpoints.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No endpoints yet. Click "New Endpoint" to deploy one.</td></tr>`;
    return;
  }
  tbody.innerHTML = endpoints.map((ep) => `
    <tr data-id="${escapeHtml(ep.id)}">
      <td>${escapeHtml(ep.name || ep.id)}<div class="hint mono">${escapeHtml(ep.id)}</div></td>
      <td><span class="badge ${ep.state?.state === 'serving' ? 'ok' : 'warn'}">${escapeHtml(ep.state?.state || 'unknown')}</span></td>
      <td class="wrap mono">${ep.url ? `<a href="${escapeHtml(ep.url)}" target="_blank" rel="noopener">${escapeHtml(ep.url)}</a>` : '—'}</td>
      <td>${escapeHtml(ep.workerConfig?.minNum ?? '—')}–${escapeHtml(ep.workerConfig?.maxNum ?? '—')}</td>
      <td>${escapeHtml(ep.workerConfig?.gpuNum ?? '—')}</td>
      <td class="actions">
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      if (!confirmAction('Delete this endpoint? All its workers will be torn down. This cannot be undone.')) return;
      await withBusy(btn, async () => {
        await api('gpu-instance/openapi/v1/endpoint/delete', { method: 'POST', body: { name: id } });
        toast('Endpoint deleted.', 'success');
        await loadEndpoints();
      });
    });
  });
}

document.getElementById('btn-new-endpoint').addEventListener('click', openCreateEndpointModal);

async function openCreateEndpointModal() {
  let products = [], storages = [], limits = null;
  try {
    [products, storages, limits] = await Promise.all([
      getProducts(),
      getStorages().catch(() => []),
      api('gpu-instance/openapi/v1/endpoint/limit').catch(() => null),
    ]);
  } catch (err) { toast(err.message, 'error'); return; }

  const productOpts = products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} — ${money(p.price)}/hr</option>`).join('');
  const storageOpts = `<option value="">— local storage (30GB) —</option>` + storages.map((s) => `<option value="${escapeHtml(s.storageId)}">${escapeHtml(s.storageName)} (${s.storageSize}GB, ${escapeHtml(s.clusterId)})</option>`).join('');
  const hint = (lo, hi) => (limits ? `Range: ${limits[lo]}–${limits[hi]}` : '');

  const bodyHtml = `
    <div class="field-row">
      <div class="field"><label>Endpoint name</label><input name="name" placeholder="my-endpoint" /></div>
      <div class="field"><label>App name (URL slug, optional)</label><input name="appName" /></div>
    </div>
    <div class="field"><label>GPU product</label><select name="productId" required>${productOpts}</select></div>
    <div class="field"><label>Image URL</label><input name="image" required placeholder="docker.io/yourname/worker:latest" /></div>
    <div class="field-row">
      <div class="field"><label>Registry auth ID (optional)</label><input name="authId" /></div>
      <div class="field"><label>Container command (optional)</label><input name="command" /></div>
    </div>
    <fieldset>
      <legend>Worker scaling</legend>
      <div class="field-row-3">
        <div class="field"><label>Min workers</label><input type="number" name="minNum" value="0" min="0" /><div class="hint">${hint('minWorkerNum', 'maxWorkerNum')}</div></div>
        <div class="field"><label>Max workers</label><input type="number" name="maxNum" value="3" min="1" /></div>
        <div class="field"><label>GPUs / worker</label><input type="number" name="gpuNum" value="1" min="1" /></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Idle timeout (s)</label><input type="number" name="freeTimeout" value="300" /></div>
        <div class="field"><label>Max concurrent / worker</label><input type="number" name="maxConcurrent" value="1" /></div>
        <div class="field"><label>Request timeout (s)</label><input type="number" name="requestTimeout" value="300" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Scaling policy</label><select name="policyType"><option value="queue">Queue wait time</option><option value="concurrency">Requests in queue</option></select></div>
        <div class="field"><label>Policy value</label><input type="number" name="policyValue" value="30" /></div>
      </div>
    </fieldset>
    <fieldset>
      <legend>Networking &amp; storage</legend>
      <div class="field-row">
        <div class="field"><label>HTTP port</label><input type="number" name="port" value="8000" required /></div>
        <div class="field"><label>Health check path</label><input name="healthPath" value="/health" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Storage</label><select name="storageId">${storageOpts}</select></div>
        <div class="field"><label>Mount path</label><input name="mountPath" value="/data" /></div>
      </div>
    </fieldset>
    <div class="field"><label>Environment variables (KEY=value, one per line)</label><textarea name="envs"></textarea></div>
  `;

  openModal({
    title: 'New Serverless Endpoint',
    subtitle: 'Deploys an autoscaling HTTP endpoint. Workers incur charges while running.',
    bodyHtml,
    submitLabel: 'Create Endpoint',
    wide: true,
    onSubmit: async (fd, close) => {
      const storageId = fd.get('storageId');
      const volumeMounts = storageId
        ? [{ type: 'network', id: storageId, mountPath: fd.get('mountPath') || '/data' }]
        : [{ type: 'local', size: 30, mountPath: fd.get('mountPath') || '/data' }];
      const selectedStorage = storages.find((s) => s.storageId === storageId);

      const payload = {
        endpoint: {
          name: fd.get('name') || undefined,
          appName: fd.get('appName') || undefined,
          clusterID: selectedStorage ? selectedStorage.clusterId : undefined,
          workerConfig: {
            minNum: Number(fd.get('minNum')) || 0,
            maxNum: Number(fd.get('maxNum')) || 1,
            freeTimeout: Number(fd.get('freeTimeout')) || 300,
            maxConcurrent: Number(fd.get('maxConcurrent')) || 1,
            gpuNum: Number(fd.get('gpuNum')) || 1,
            requestTimeout: Number(fd.get('requestTimeout')) || 300,
          },
          ports: [{ port: String(fd.get('port')) }],
          policy: { type: fd.get('policyType'), value: Number(fd.get('policyValue')) || 0 },
          image: {
            image: fd.get('image'),
            authId: fd.get('authId') || undefined,
            command: fd.get('command') || undefined,
          },
          products: [{ id: fd.get('productId') }],
          rootfsSize: 100,
          volumeMounts,
          healthy: { path: fd.get('healthPath') || '/' },
        },
      };
      const envs = parseEnvLines(fd.get('envs'));
      if (envs.length) payload.endpoint.envs = envs;

      const res = await api('gpu-instance/openapi/v1/endpoint/create', { method: 'POST', body: payload });
      toast(`Endpoint created: ${res.id}`, 'success');
      close();
      await loadEndpoints();
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Templates                                                              */
/* ---------------------------------------------------------------------- */

/**
 * The Templates page shows two independent namespaces that unhelpfully share
 * the word "template": sandbox templates (usable as `template` in
 * sandbox.create) and GPU-instance container templates. Querying the
 * GPU-instance endpoint returns an empty list even when sandbox templates
 * exist, which previously made this page look broken for anyone who had only
 * ever created sandbox templates. Both are rendered, each clearly labelled.
 */
async function loadSandboxTemplates() {
  const table = document.getElementById('tbl-sandbox-templates');
  table.querySelector('thead').innerHTML = `<tr><th>Alias</th><th>Template ID</th><th>Build</th><th>CPU / Mem</th><th>Disk</th><th>Visibility</th><th>Spawns</th><th>Last used</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Loading…</td></tr>`;

  const templates = await local('/api/sandbox-templates');
  if (!templates.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">You don't own any sandbox templates. Novita's built-in ones (base, browser-chromium) are still usable when creating a sandbox.</td></tr>`;
    return;
  }
  tbody.innerHTML = templates.map((t) => `
    <tr>
      <td class="mono">${escapeHtml(t.aliases.join(', ') || '—')}</td>
      <td class="mono wrap">${escapeHtml(t.templateId)}</td>
      <td>${escapeHtml(t.buildStatus || '—')}</td>
      <td>${escapeHtml(t.cpuCount ?? '—')} / ${escapeHtml(t.memoryMB ?? '—')}MB</td>
      <td>${t.diskSizeMB ? `${Math.round(t.diskSizeMB / 1024)} GB` : '—'}</td>
      <td>${t.public ? 'public' : 'private'}</td>
      <td>${escapeHtml(t.spawnCount ?? 0)}</td>
      <td>${t.lastSpawnedAt ? new Date(t.lastSpawnedAt).toLocaleString() : '—'}</td>
    </tr>`).join('');
}

async function loadGpuTemplates() {
  const table = document.getElementById('tbl-templates');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>Image</th><th>Root disk</th><th>Created</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/templates', { query: { channel: 'private', isMyCommunity: true, pageSize: 200, pageNum: 0 } });
  const templates = data.template || [];
  if (!templates.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No private templates yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = templates.map((t) => `
    <tr data-id="${escapeHtml(t.Id)}">
      <td>${escapeHtml(t.name)}</td>
      <td class="mono wrap">${escapeHtml(t.image)}</td>
      <td>${escapeHtml(t.rootfsSize)} GB</td>
      <td>${unixToLocal(t.createdAt)}</td>
      <td class="actions"><button class="btn btn-sm btn-danger" data-act="delete">Delete</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirmAction('Delete this template?')) return;
      await withBusy(btn, async () => {
        await api('gpu-instance/openapi/v1/template/delete', { method: 'POST', body: { templateId: id } });
        toast('Template deleted.', 'success');
        await loadGpuTemplates();
      });
    });
  });
}

/**
 * Loads both tables concurrently and, crucially, independently: the two come
 * from different APIs, so one being unreachable (or the account simply having
 * no templates of that kind) must still leave the other rendered. allSettled
 * rather than all — a rejection from either would otherwise abandon the whole
 * page and leave both tables stuck on "Loading…".
 */
async function loadTemplates() {
  const results = await Promise.allSettled([loadSandboxTemplates(), loadGpuTemplates()]);
  const failures = [
    { label: 'Sandbox templates', tableId: 'tbl-sandbox-templates', colspan: 8, result: results[0] },
    { label: 'GPU instance templates', tableId: 'tbl-templates', colspan: 5, result: results[1] },
  ].filter((f) => f.result.status === 'rejected');

  for (const f of failures) {
    const tbody = document.getElementById(f.tableId).querySelector('tbody');
    tbody.innerHTML = `<tr><td colspan="${f.colspan}" class="empty-state">Failed to load: ${escapeHtml(f.result.reason?.message || 'unknown error')}</td></tr>`;
  }
  if (failures.length) {
    toast(`${failures.map((f) => f.label).join(' and ')} failed to load.`, 'error');
  }
}

document.getElementById('btn-new-template').addEventListener('click', () => {
  const bodyHtml = `
    <div class="field"><label>Name</label><input name="name" required /></div>
    <div class="field"><label>Image URL</label><input name="image" required placeholder="docker.io/library/ubuntu:latest" /></div>
    <div class="field-row">
      <div class="field"><label>Registry auth ID (optional)</label><input name="imageAuth" /></div>
      <div class="field"><label>Root disk (GB)</label><input type="number" name="rootfsSize" value="20" required /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Start command (optional)</label><input name="startCommand" /></div>
      <div class="field"><label>Entrypoint (optional)</label><input name="entrypoint" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>HTTP ports (comma-separated)</label><input name="httpPorts" placeholder="8080,8888" /></div>
      <div class="field"><label>TCP ports (comma-separated)</label><input name="tcpPorts" placeholder="22" /></div>
    </div>
    <div class="field"><label>Environment variables (KEY=value, one per line)</label><textarea name="envs"></textarea></div>
    <div class="field"><label>README (Markdown, optional)</label><textarea name="readme"></textarea></div>
    <div class="field"><label>Min CUDA version (optional)</label><input name="minCudaVersion" placeholder="11.8" /></div>
  `;
  openModal({
    title: 'New Template',
    subtitle: 'Reusable private instance configuration.',
    bodyHtml,
    submitLabel: 'Create Template',
    wide: true,
    onSubmit: async (fd, close) => {
      const ports = [];
      const httpPorts = (fd.get('httpPorts') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      const tcpPorts = (fd.get('tcpPorts') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      if (httpPorts.length) ports.push({ type: 'http', ports: httpPorts });
      if (tcpPorts.length) ports.push({ type: 'tcp', ports: tcpPorts });

      const template = {
        name: fd.get('name'),
        type: 'instance',
        channel: 'private',
        image: fd.get('image'),
        imageAuth: fd.get('imageAuth') || undefined,
        startCommand: fd.get('startCommand') || undefined,
        entrypoint: fd.get('entrypoint') || undefined,
        rootfsSize: Number(fd.get('rootfsSize')) || 20,
        readme: fd.get('readme') || undefined,
        minCudaVersion: fd.get('minCudaVersion') || undefined,
      };
      if (ports.length) template.ports = ports;
      const envs = parseEnvLines(fd.get('envs'));
      if (envs.length) template.envs = envs;

      const res = await api('gpu-instance/openapi/v1/template/create', { method: 'POST', body: { template } });
      toast(`Template created: ${res.templateId}`, 'success');
      close();
      await loadTemplates();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* VPC Networks                                                           */
/* ---------------------------------------------------------------------- */

async function loadNetworks() {
  const table = document.getElementById('tbl-networks');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>State</th><th>Segment</th><th>Cluster</th><th>Instances</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/networks', { query: { pageSize: 200, pageNum: 0 } });
  const networks = data.networks || data.network || [];
  if (!networks.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No VPC networks yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = networks.map((n) => `
    <tr data-id="${escapeHtml(n.Id)}" data-name="${escapeHtml(n.name || '')}">
      <td>${escapeHtml(n.name || n.Id)}<div class="hint mono">${escapeHtml(n.Id)}</div></td>
      <td><span class="badge ${n.state?.[0]?.state === 'ready' ? 'ok' : 'warn'}">${escapeHtml(n.state?.[0]?.state || 'unknown')}</span></td>
      <td class="mono">${escapeHtml(n.segment)}</td>
      <td>${escapeHtml(n.clusterId)}</td>
      <td>${(n.Addresses || []).length}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="rename">Rename</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirmAction('Delete this VPC network? Ensure no instances are attached first.')) return;
      await withBusy(btn, async () => {
        await api('gpu-instance/openapi/v1/network/delete', { method: 'POST', body: { networkId: id } });
        toast('Network deleted.', 'success');
        await loadNetworks();
      });
    });
  });
  tbody.querySelectorAll('button[data-act="rename"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      openModal({
        title: 'Rename VPC Network',
        bodyHtml: `<div class="field"><label>New name</label><input name="name" value="${escapeHtml(tr.dataset.name)}" required /></div>`,
        submitLabel: 'Rename',
        onSubmit: async (fd, close) => {
          await api('gpu-instance/openapi/v1/network/update', { method: 'POST', body: { networkId: id, name: fd.get('name') } });
          toast('Network renamed.', 'success');
          close();
          await loadNetworks();
        },
      });
    });
  });
}

document.getElementById('btn-new-network').addEventListener('click', async () => {
  let clusters = [];
  try { clusters = await getClusters(); } catch (err) { toast(err.message, 'error'); return; }
  const clusterOpts = clusters.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  openModal({
    title: 'New VPC Network',
    bodyHtml: `
      <div class="field"><label>Cluster</label><select name="clusterId" required>${clusterOpts}</select></div>
      <div class="field"><label>Name (optional)</label><input name="name" maxlength="30" /></div>`,
    submitLabel: 'Create Network',
    onSubmit: async (fd, close) => {
      await api('gpu-instance/openapi/v1/network/create', { method: 'POST', body: { clusterId: fd.get('clusterId'), name: fd.get('name') || undefined } });
      toast('Network created.', 'success');
      close();
      await loadNetworks();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* Network Storage                                                        */
/* ---------------------------------------------------------------------- */

async function loadStorage() {
  const table = document.getElementById('tbl-storage');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>Size (GB)</th><th>Cluster</th><th>Price</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/networkstorages/list', { query: { pageNo: 1, pageSize: 200 } });
  const storages = data.data || [];
  if (!storages.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No network storage volumes yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = storages.map((s) => `
    <tr data-id="${escapeHtml(s.storageId)}" data-name="${escapeHtml(s.storageName || '')}" data-size="${escapeHtml(s.storageSize ?? '')}">
      <td>${escapeHtml(s.storageName)}<div class="hint mono">${escapeHtml(s.storageId)}</div></td>
      <td>${escapeHtml(s.storageSize)}</td>
      <td>${escapeHtml(s.clusterName || s.clusterId)}</td>
      <td>${escapeHtml(s.price ?? '—')}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="edit">Edit</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirmAction('Delete this storage volume? Data will be lost permanently.')) return;
      await withBusy(btn, async () => {
        await api('gpu-instance/openapi/v1/networkstorage/delete', { method: 'POST', body: { storageId: id } });
        toast('Storage deleted.', 'success');
        await loadStorage();
      });
    });
  });
  tbody.querySelectorAll('button[data-act="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      openModal({
        title: 'Edit Network Storage',
        bodyHtml: `
          <div class="field"><label>Name</label><input name="storageName" value="${escapeHtml(tr.dataset.name)}" required /></div>
          <div class="field"><label>Size (GB)</label><input type="number" name="storageSize" value="${escapeHtml(tr.dataset.size)}" required /></div>`,
        submitLabel: 'Save',
        onSubmit: async (fd, close) => {
          await api('gpu-instance/openapi/v1/networkstorage/update', { method: 'POST', body: { storageId: tr.dataset.id, storageName: fd.get('storageName'), storageSize: fd.get('storageSize') } });
          toast('Storage updated.', 'success');
          close();
          await loadStorage();
        },
      });
    });
  });
}

document.getElementById('btn-new-storage').addEventListener('click', async () => {
  let clusters = [];
  try { clusters = await getClusters(); } catch (err) { toast(err.message, 'error'); return; }
  const clusterOpts = clusters.filter((c) => c.supportNetworkStorage).map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
    || clusters.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  openModal({
    title: 'New Network Storage',
    bodyHtml: `
      <div class="field"><label>Cluster</label><select name="clusterId" required>${clusterOpts}</select></div>
      <div class="field"><label>Name</label><input name="storageName" required /></div>
      <div class="field"><label>Size (GB)</label><input type="number" name="storageSize" min="1" value="50" required /></div>`,
    submitLabel: 'Create Storage',
    onSubmit: async (fd, close) => {
      await api('gpu-instance/openapi/v1/networkstorage/create', { method: 'POST', body: { clusterId: fd.get('clusterId'), storageName: fd.get('storageName'), storageSize: Number(fd.get('storageSize')) } });
      toast('Storage created.', 'success');
      close();
      await loadStorage();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* Container Registry Auth                                                */
/* ---------------------------------------------------------------------- */

async function loadRegistry() {
  const table = document.getElementById('tbl-registry');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>ID</th><th>Username</th><th>Password</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const data = await api('gpu-instance/openapi/v1/repository/auths');
  const creds = data.data || [];
  if (!creds.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No registry credentials yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = creds.map((c) => `
    <tr data-id="${escapeHtml(c.id)}">
      <td>${escapeHtml(c.name)}</td>
      <td class="mono">${escapeHtml(c.id)}</td>
      <td>${escapeHtml(c.username)}</td>
      <td class="mono"><span class="pw-mask">••••••••</span></td>
      <td class="actions"><button class="btn btn-sm btn-danger" data-act="delete">Delete</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirmAction('Delete this registry credential?')) return;
      await withBusy(btn, async () => {
        await api('gpu-instance/openapi/v1/repository/auth/delete', { method: 'POST', body: { id } });
        toast('Credential deleted.', 'success');
        await loadRegistry();
      });
    });
  });
}

document.getElementById('btn-new-registry').addEventListener('click', () => {
  openModal({
    title: 'New Registry Credential',
    bodyHtml: `
      <div class="field"><label>Name</label><input name="name" required /></div>
      <div class="field"><label>Username</label><input name="username" required /></div>
      <div class="field"><label>Password / token</label><input type="password" name="password" required /></div>`,
    submitLabel: 'Save Credential',
    onSubmit: async (fd, close) => {
      await api('gpu-instance/openapi/v1/repository/auth/save', { method: 'POST', body: { name: fd.get('name'), username: fd.get('username'), password: fd.get('password') } });
      toast('Credential saved.', 'success');
      close();
      await loadRegistry();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* Sandboxes                                                              */
/* ---------------------------------------------------------------------- */

const SANDBOX_TIMEOUT_MINUTES = 30;

function sandboxRow(sbx) {
  const stateBadge = sbx.state === 'running' ? 'ok' : 'warn';
  const meta = Object.entries(sbx.metadata || {}).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${v}`).join(', ') || '—';
  const hasCustomName = sbx.name && sbx.name !== sbx.sandboxId;
  return `<tr data-id="${escapeHtml(sbx.sandboxId)}" data-name="${hasCustomName ? escapeHtml(sbx.name) : ''}">
    <td>${hasCustomName ? escapeHtml(sbx.name) : '<span class="hint">(unnamed)</span>'}<div class="hint mono">${escapeHtml(sbx.sandboxId)}</div></td>
    <td><span class="badge ${stateBadge}">${escapeHtml(sbx.state)}</span></td>
    <td>${escapeHtml(sbx.templateId || '—')}</td>
    <td>${escapeHtml(sbx.cpuCount ?? '—')} / ${escapeHtml(sbx.memoryMB ?? '—')}MB</td>
    <td class="wrap">${escapeHtml(meta)}</td>
    <td>${sbx.endAt ? new Date(sbx.endAt).toLocaleString() : '—'}</td>
    <td class="actions">
      <button class="btn btn-sm" data-act="pause" ${sbx.state === 'running' ? '' : 'disabled'}>Pause</button>
      <button class="btn btn-sm" data-act="resume" ${sbx.state === 'paused' ? '' : 'disabled'}>Resume</button>
      <button class="btn btn-sm" data-act="rename">Rename</button>
      <button class="btn btn-sm" data-act="terminal">Terminal</button>
      <button class="btn btn-sm" data-act="ssh">SSH</button>
      <button class="btn btn-sm" data-act="enable-ssh">Enable SSH</button>
      <button class="btn btn-sm" data-act="usage">Usage</button>
      <button class="btn btn-sm" data-act="setup-claude">Setup Claude Code</button>
      <button class="btn btn-sm btn-danger" data-act="kill">Kill</button>
    </td>
  </tr>`;
}

async function loadSandboxes() {
  const table = document.getElementById('tbl-sandboxes');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>State</th><th>Template</th><th>CPU / Mem</th><th>Metadata</th><th>Ends</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Loading…</td></tr>`;

  const data = await local('/api/sandbox/list');
  const sandboxes = data || [];
  if (!sandboxes.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No sandboxes yet. Click "New Sandbox" to create one, or ask the AI Agent.</td></tr>`;
    return;
  }
  tbody.innerHTML = sandboxes.map(sandboxRow).join('');

  tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleSandboxAction(btn));
  });
}

async function handleSandboxAction(btn) {
  const id = btn.closest('tr').dataset.id;
  const act = btn.dataset.act;

  if (act === 'kill') {
    if (!confirmAction('Permanently kill this sandbox? This cannot be undone.')) return;
    await withBusy(btn, async () => { await local(`/api/sandbox/${id}/kill`, { method: 'POST' }); toast('Sandbox killed.', 'success'); await loadSandboxes(); });
    return;
  }
  if (act === 'pause') {
    await withBusy(btn, async () => { await local(`/api/sandbox/${id}/pause`, { method: 'POST' }); toast('Sandbox paused.', 'success'); await loadSandboxes(); });
    return;
  }
  if (act === 'resume') {
    await withBusy(btn, async () => { await local(`/api/sandbox/${id}/resume`, { method: 'POST' }); toast('Sandbox resumed.', 'success'); await loadSandboxes(); });
    return;
  }
  if (act === 'rename') {
    const currentName = btn.closest('tr').dataset.name;
    openModal({
      title: 'Rename Sandbox',
      subtitle: `${id} — Novita has no rename API for sandboxes, so this name lives in this app's own local storage.`,
      bodyHtml: `<div class="field"><label>Name</label><input name="name" required value="${escapeHtml(currentName)}" placeholder="my-dev-box" /></div>`,
      submitLabel: 'Rename',
      onSubmit: async (fd, close) => {
        await local(`/api/sandbox/${id}/rename`, { method: 'POST', body: { name: fd.get('name') } });
        toast('Sandbox renamed.', 'success');
        close();
        await loadSandboxes();
      },
    });
    return;
  }
  if (act === 'terminal') {
    // A plain window.open (no noopener) so the new tab inherits this tab's
    // sessionStorage per the HTML spec — same-origin popups get a clone of
    // the opener's session storage — which is how terminal.html picks up
    // the session-only API key without it ever going in the URL.
    window.open(`/terminal.html?sandbox=${encodeURIComponent(id)}`, '_blank');
    return;
  }
  if (act === 'usage') {
    await withBusy(btn, () => showUsageModal(id));
    return;
  }
  if (act === 'ssh') {
    await withBusy(btn, async () => {
      const res = await local(`/api/sandbox/${id}/ssh-command`);
      showSshModal(id, res.command);
    });
    return;
  }
  if (act === 'enable-ssh') {
    openModal({
      title: 'Enable SSH on this sandbox',
      subtitle: 'Installs the websocat proxy on port 8081 and adds your public key, so SSH works even though this sandbox was not created from the "ssh-ready" template.',
      bodyHtml: `
        <div class="field">
          <label>Your SSH public key</label>
          <textarea name="sshPublicKey" placeholder="ssh-ed25519 AAAA... your-key-comment" style="min-height:60px; font-family: monospace;"></textarea>
          <div class="hint">Paste the contents of e.g. <span class="mono">~/.ssh/id_ed25519.pub</span> — the public key, never the private one. Safe to re-run: an existing key is not duplicated and any proxy already listening is left alone.</div>
        </div>`,
      submitLabel: 'Enable SSH',
      onSubmit: async (fd, close) => {
        const res = await local(`/api/sandbox/${id}/enable-ssh`, {
          method: 'POST',
          body: { sshPublicKey: (fd.get('sshPublicKey') || '').trim() },
        });
        toast('SSH enabled.', 'success');
        close();
        showSshModal(id, res.command);
      },
    });
    return;
  }
  if (act === 'setup-claude') {
    openModal({
      title: 'Setup Claude Code Dev Environment',
      subtitle: `Sandbox ${id} — installs the Claude Code CLI and a headless Chromium (via Playwright), then actually launches it to verify. Can take 1-2 minutes on a plain "base" template while the browser downloads.`,
      bodyHtml: `
        <div class="field"><label>Anthropic API key</label><input type="password" name="anthropicApiKey" placeholder="sk-ant-…" /></div>
        <div class="hint" style="margin:-8px 0 14px;">Needed for Claude Code to actually run tasks non-interactively. Alternatively, paste a subscription token below if you've already run <span class="mono">claude setup-token</span> somewhere with a browser (that step itself can't be done from inside the sandbox).</div>
        <div class="field"><label>Claude Code OAuth token (optional, instead of the API key)</label><input type="password" name="claudeCodeOauthToken" placeholder="sk-ant-oat01-…" /></div>
        <div class="field" id="setup-claude-output" style="display:none;"><label>Result</label><textarea readonly style="min-height:140px;"></textarea></div>`,
      submitLabel: 'Install',
      onSubmit: async (fd) => {
        const res = await local(`/api/sandbox/${id}/setup-claude-code`, {
          method: 'POST',
          body: { anthropicApiKey: fd.get('anthropicApiKey') || undefined, claudeCodeOauthToken: fd.get('claudeCodeOauthToken') || undefined },
        });
        const box = document.getElementById('setup-claude-output');
        box.style.display = '';
        box.querySelector('textarea').value =
          `Claude Code ${res.claudeVersion} installed at ${res.claudeBinary}\n` +
          `${res.browserStatus}\n` +
          `Auth configured: ${res.authConfigured ? 'yes' : 'no — set a key/token before running tasks'}\n\n` +
          `${res.usage}`;
        toast('Claude Code dev environment ready.', 'success');
      },
    });
    return;
  }
}

document.getElementById('btn-new-sandbox').addEventListener('click', () => {
  openModal({
    title: 'New Sandbox',
    subtitle: 'Creates an isolated execution environment via Novita Sandbox.',
    bodyHtml: `
      <div class="field-row">
        <div class="field"><label>Name (optional, for easy reference)</label><input name="name" placeholder="my-dev-box" /></div>
        <div class="field">
          <label>Template preset</label>
          <select id="template-preset">
            <option value="">Default (base) — plain Linux, no browser</option>
            <option value="browser-chromium">Browser testing — headless Chromium + CDP port 9223</option>
            <option value="ssh-ready">SSH access — connect from your local terminal via SSH</option>
            <option value="__custom__">Custom…</option>
          </select>
        </div>
      </div>
      <div class="field" id="template-custom-field" hidden><label>Custom template name or ID</label><input name="template" placeholder="my-template-id" /></div>
      <div class="field" id="ssh-key-field" hidden>
        <label>Your SSH public key</label>
        <textarea name="sshPublicKey" placeholder="ssh-ed25519 AAAA... your-key-comment" style="min-height:60px; font-family: monospace;"></textarea>
        <div class="hint">Paste the contents of e.g. <span class="mono">~/.ssh/id_ed25519.pub</span>. After creation, use the sandbox's "SSH" button for the exact connect command (requires <span class="mono">brew install websocat</span> locally, once).</div>
      </div>
      <div class="field"><label>Timeout (minutes)</label><input type="number" name="timeoutMinutes" value="${SANDBOX_TIMEOUT_MINUTES}" min="1" /></div>
      <div class="field"><label>Metadata (KEY=value, one per line)</label><textarea name="metadata" placeholder="purpose=demo"></textarea></div>
      <div class="field"><label>Environment variables (KEY=value, one per line)</label><textarea name="envs"></textarea></div>
      <div class="field"><label><input type="checkbox" name="allowInternetAccess" checked style="width:auto; display:inline-block;" /> Allow internet access</label></div>
      <fieldset>
        <legend>Persistent data (optional)</legend>
        <div class="field-row">
          <div class="field"><label>Volume name</label><input name="volumeName" placeholder="my-data" /></div>
          <div class="field"><label>Mount path</label><input name="volumeMountPath" value="/home/user/app/data" /></div>
        </div>
        <div class="hint">Data written under the mount path survives even after this sandbox is killed — mount the same volume name into a future sandbox to pick it back up. Created automatically if it doesn't exist.</div>
      </fieldset>`,
    submitLabel: 'Create Sandbox',
    onSubmit: async (fd, close) => {
      const metadata = Object.fromEntries(parseEnvLines(fd.get('metadata')).map((e) => [e.key, e.value]));
      const envs = Object.fromEntries(parseEnvLines(fd.get('envs')).map((e) => [e.key, e.value]));
      const volumeName = fd.get('volumeName');
      const presetValue = document.getElementById('template-preset').value;
      const template = presetValue === '__custom__' ? fd.get('template') : presetValue;
      const sshPublicKey = presetValue === 'ssh-ready' ? (fd.get('sshPublicKey') || '').trim() : undefined;
      const res = await local('/api/sandbox/create', {
        method: 'POST',
        body: {
          name: fd.get('name') || undefined,
          template: template || undefined,
          timeoutMs: Number(fd.get('timeoutMinutes') || SANDBOX_TIMEOUT_MINUTES) * 60000,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          envs: Object.keys(envs).length ? envs : undefined,
          allowInternetAccess: fd.get('allowInternetAccess') === 'on',
          volumeMounts: volumeName ? [{ volumeName, mountPath: fd.get('volumeMountPath') || '/home/user/data' }] : undefined,
          sshPublicKey: sshPublicKey || undefined,
        },
      });
      toast(`Sandbox created: ${res.name}`, 'success');
      close();
      await loadSandboxes();
      if (presetValue === 'ssh-ready' && sshPublicKey) {
        const sshInfo = await local(`/api/sandbox/${res.sandboxId}/ssh-command`);
        showSshModal(res.sandboxId, sshInfo.command);
      }
    },
  });

  const presetSelect = document.getElementById('template-preset');
  const customField = document.getElementById('template-custom-field');
  const sshKeyField = document.getElementById('ssh-key-field');
  presetSelect.addEventListener('change', () => {
    customField.hidden = presetSelect.value !== '__custom__';
    sshKeyField.hidden = presetSelect.value !== 'ssh-ready';
  });

  // Adds the account's own sandbox templates to the hardcoded presets above,
  // so a template built here is selectable without going through "Custom…".
  //
  // It only ADDS. The presets are deliberately never disabled based on this
  // list: /api/sandbox-templates returns templates the account OWNS, while
  // presets like "browser-chromium" are Novita-provided and absent from it —
  // marking those unavailable was tested and wrong (creating a
  // "browser-chromium" sandbox succeeds while it is missing from the list), so
  // that check would disable a preset that works.
  //
  // Runs after the modal is open so it never delays showing it, and is
  // non-fatal: if the lookup fails the presets behave exactly as before.
  local('/api/sandbox-templates').then((templates) => {
    const known = new Set([...presetSelect.options].map((o) => o.value));
    const extras = templates.filter((t) => !t.aliases.some((a) => known.has(a)));
    if (!extras.length) return;
    const group = document.createElement('optgroup');
    group.label = 'Your sandbox templates';
    for (const t of extras) {
      const opt = document.createElement('option');
      opt.value = t.aliases[0] || t.templateId;
      opt.textContent = `${opt.value}${t.buildStatus && t.buildStatus !== 'ready' ? ` (${t.buildStatus})` : ''}`;
      group.appendChild(opt);
    }
    presetSelect.insertBefore(group, presetSelect.querySelector('option[value="__custom__"]'));
  }).catch(() => {});
});

/**
 * Shows the connect command. Shared by the "SSH" button and the tail of
 * "Enable SSH" so both present the command identically.
 *
 * The command is only usable if something is actually listening on 8081 in
 * that sandbox — true for the "ssh-ready" template or after "Enable SSH", and
 * false for a plain base-template sandbox, where it fails with a "502 Bad
 * Gateway" from websocat that says nothing about the cause. Hence the hint
 * pointing at the fix rather than leaving that to be worked out.
 */
function showSshModal(nameOrId, command) {
  openModal({
    title: 'SSH into this sandbox',
    subtitle: `Sandbox ${nameOrId}`,
    bodyHtml: `
      <div class="field"><label>Run this from your local terminal (requires <span class="mono">brew install websocat</span> once)</label>
      <textarea readonly style="min-height:70px; font-family: monospace;">${escapeHtml(command)} -i ~/.ssh/your_private_key</textarea></div>
      <div class="hint">Replace <span class="mono">~/.ssh/your_private_key</span> with the private key matching the public key installed on this sandbox.</div>
      <div class="hint">Getting <span class="mono">502 Bad Gateway</span>? Nothing is listening on port 8081 — this sandbox was not created from the "ssh-ready" template. Use <strong>Enable SSH</strong> to install the proxy and your key.</div>`,
    submitLabel: 'Close',
    onSubmit: async (fd, close) => close(),
  });
}

/* ---- Usage (CPU / memory / disk) ---- */

async function showUsageModal(nameOrId) {
  const samples = await local(`/api/sandbox/${nameOrId}/metrics`);
  const rows = (samples || []).slice(-15).reverse();
  const bodyHtml = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>CPU</th><th>Memory</th><th>Disk</th></tr></thead><tbody>
        ${rows.map((s) => `<tr>
          <td>${new Date(s.timestamp).toLocaleTimeString()}</td>
          <td>${s.cpuUsedPct.toFixed(1)}% of ${s.cpuCount} vCPU</td>
          <td>${s.memUsedMB} / ${s.memTotalMB} MB</td>
          <td>${s.diskUsedMB} / ${s.diskTotalMB} MB</td>
        </tr>`).join('')}
      </tbody></table></div>`
    : `<div class="empty-state">No metrics reported yet — try again in a few seconds.</div>`;
  openModal({
    title: 'Resource Usage',
    subtitle: `Sandbox ${nameOrId} — most recent samples first`,
    bodyHtml,
    submitLabel: 'Close',
    onSubmit: async (fd, close) => close(),
  });
}

/* ---------------------------------------------------------------------- */
/* Data Volumes                                                           */
/* ---------------------------------------------------------------------- */

async function loadVolumes() {
  const table = document.getElementById('tbl-volumes');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>ID</th><th>Used / Quota</th><th>Mounted On</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const volumes = await local('/api/volume/list');
  if (!volumes || !volumes.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No volumes yet. Create one to keep data (like this dashboard's saved accounts) around across sandbox recreation.</td></tr>`;
    return;
  }
  tbody.innerHTML = volumes.map((v) => {
    const mounts = v.mountedOn || [];
    const mountedText = mounts.length
      ? mounts.map((m) => `${escapeHtml(m.sandboxName)} (${escapeHtml(m.path)})`).join(', ')
      : '<span class="hint">not mounted</span>';
    return `
    <tr data-id="${escapeHtml(v.volumeId)}" data-name="${escapeHtml(v.name)}">
      <td>${escapeHtml(v.name)}</td>
      <td class="mono">${escapeHtml(v.volumeId)}</td>
      <td>${((v.usedSizeBytes || 0) / (1024 * 1024)).toFixed(1)} MB / ${escapeHtml(v.quotaSizeGiB)} GiB</td>
      <td class="wrap">${mountedText}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="mount">Mount into sandbox</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      if (!confirmAction(`Permanently delete volume "${tr.dataset.name}" and all its data? This cannot be undone.`)) return;
      await withBusy(btn, async () => {
        await local(`/api/volume/${tr.dataset.id}`, { method: 'DELETE' });
        toast('Volume deleted.', 'success');
        await loadVolumes();
      });
    });
  });
  tbody.querySelectorAll('button[data-act="mount"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      openModal({
        title: 'Mount Volume',
        subtitle: `Volume "${tr.dataset.name}" — mounts into an already-running sandbox`,
        bodyHtml: `
          <div class="field"><label>Sandbox name or ID</label><input name="sandboxId" required placeholder="my-sandbox" /></div>
          <div class="field"><label>Mount path</label><input name="mountPath" required value="/home/user/app/data" /></div>`,
        submitLabel: 'Mount',
        onSubmit: async (fd, close) => {
          await local(`/api/sandbox/${fd.get('sandboxId')}/mount-volume`, {
            method: 'POST',
            body: { volumeName: tr.dataset.name, mountPath: fd.get('mountPath') },
          });
          toast('Volume mounted.', 'success');
          close();
        },
      });
    });
  });
}

document.getElementById('btn-new-volume').addEventListener('click', () => {
  openModal({
    title: 'New Volume',
    subtitle: 'Persistent storage, independent of any sandbox\'s lifecycle.',
    bodyHtml: `
      <div class="field"><label>Name</label><input name="name" required placeholder="dashboard-data" /></div>
      <div class="field"><label>Quota (GiB)</label><input type="number" name="quotaSizeGiB" value="1" min="1" /></div>`,
    submitLabel: 'Create Volume',
    onSubmit: async (fd, close) => {
      await local('/api/volume/create', { method: 'POST', body: { name: fd.get('name'), quotaSizeGiB: Number(fd.get('quotaSizeGiB')) || 1 } });
      toast('Volume created.', 'success');
      close();
      await loadVolumes();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* AI Agent                                                               */
/* ---------------------------------------------------------------------- */

let agentMessages = [];
let agentModelsLoaded = false;

function renderAgentChat() {
  const box = document.getElementById('agent-chat');
  if (!agentMessages.length) {
    box.innerHTML = `<div class="empty-state">Ask it to create a sandbox, list what's running, or deploy this dashboard somewhere. It can call real tools on your account.</div>`;
    return;
  }
  box.innerHTML = agentMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const isUser = m.role === 'user';
      const align = isUser ? 'flex-end' : 'flex-start';
      const bg = isUser ? 'var(--accent)' : 'var(--bg)';
      const color = isUser ? 'white' : 'var(--text)';
      const content = m.content ? escapeHtml(m.content).replace(/\n/g, '<br>') : '<em>(tool actions only)</em>';
      return `<div style="align-self:${align}; max-width:80%; background:${bg}; color:${color}; padding:8px 12px; border-radius:10px; font-size:13.5px;">${content}</div>`;
    }).join('');
  box.scrollTop = box.scrollHeight;
}

function renderAgentActions(actions) {
  if (!actions || !actions.length) return;
  const box = document.getElementById('agent-chat');
  const summary = actions.map((a) => `<div class="hint mono">→ ${escapeHtml(a.tool)}(${escapeHtml(JSON.stringify(a.args))}) ${a.result?.error ? '❌ ' + escapeHtml(a.result.error) : '✓'}</div>`).join('');
  const el = document.createElement('div');
  el.style.cssText = 'align-self:flex-start; max-width:90%; background:var(--panel); border:1px dashed var(--border); padding:8px 12px; border-radius:10px;';
  el.innerHTML = `<div class="hint" style="margin-bottom:4px; font-weight:600;">Actions taken</div>${summary}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

async function loadAgentPage() {
  renderAgentChat();
  if (agentModelsLoaded) return;
  const select = document.getElementById('agent-model');
  try {
    const data = await api('openai/v1/models');
    const models = (data.data || []).filter((m) => !/embed|rerank|whisper|tts/i.test(m.id));
    select.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('');
    const preferred = models.find((m) => /llama-3\.3-70b|qwen2\.5-72b|llama-3\.1-70b/i.test(m.id));
    if (preferred) select.value = preferred.id;
    agentModelsLoaded = true;
  } catch (err) {
    select.innerHTML = `<option value="">(models unavailable)</option>`;
    toast(err.message, 'error');
  }
}

document.getElementById('agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('agent-input');
  const text = input.value.trim();
  if (!text) return;
  const model = document.getElementById('agent-model').value;
  if (!model) { toast('No model selected.', 'error'); return; }

  agentMessages.push({ role: 'user', content: text });
  renderAgentChat();
  input.value = '';
  const sendBtn = document.getElementById('agent-send');

  await withBusy(sendBtn, async () => {
    const res = await local('/api/agent/chat', { method: 'POST', body: { model, messages: agentMessages } });
    agentMessages = res.messages;
    renderAgentChat();
    renderAgentActions(res.actions);
    if (res.truncated) toast('Agent stopped after several tool calls — ask it to continue if needed.', 'info');
  });
});

document.getElementById('btn-clear-chat').addEventListener('click', () => {
  agentMessages = [];
  renderAgentChat();
});

/* ---------------------------------------------------------------------- */
/* Accounts                                                               */
/* ---------------------------------------------------------------------- */

async function loadAccounts() {
  const table = document.getElementById('tbl-accounts');
  table.querySelector('thead').innerHTML = `<tr><th>Label</th><th>Key</th><th>Balance</th><th>Added</th><th>Actions</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const data = await apiRaw('/api/accounts');
  const list = data.accounts || [];
  cache.accounts = list;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No saved accounts yet. Add one to switch between multiple Novita accounts without retyping keys.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((a) => `
    <tr data-id="${escapeHtml(a.id)}">
      <td>${escapeHtml(a.label)} ${a.id === ACTIVE_ACCOUNT_ID ? '<span class="badge ok">active</span>' : ''}</td>
      <td class="mono">${escapeHtml(a.maskedKey)}</td>
      <td class="balance">…</td>
      <td>${new Date(a.createdAt).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="use">Use</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('button[data-act="use"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      ACTIVE_ACCOUNT_ID = id;
      localStorage.setItem('novita_active_account', id);
      document.getElementById('account-switcher').value = id;
      connDot.classList.remove('connected');
      api('openapi/v1/billing/balance/detail').then(() => connDot.classList.add('connected')).catch(() => {});
      toast('Switched active account.', 'success');
      loadAccounts();
    });
  });
  tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirmAction('Remove this saved account? The key will be deleted from data/accounts.json.')) return;
      await withBusy(btn, async () => {
        await apiRaw(`/api/accounts/${id}`, { method: 'DELETE' });
        if (ACTIVE_ACCOUNT_ID === id) { ACTIVE_ACCOUNT_ID = ''; localStorage.removeItem('novita_active_account'); }
        toast('Account removed.', 'success');
        await loadAccounts();
        await refreshAccountSwitcher();
      });
    });
  });

  // Fetch balances lazily per account, without blocking the table render.
  list.forEach(async (a) => {
    const cell = tbody.querySelector(`tr[data-id="${a.id}"] .balance`);
    try {
      const b = await apiRaw('/api/proxy/openapi/v1/billing/balance/detail', { headers: { 'x-novita-account': a.id } });
      if (cell) cell.textContent = money(b.availableBalance);
    } catch {
      if (cell) cell.textContent = '—';
    }
  });
}

document.getElementById('btn-new-account').addEventListener('click', () => {
  openModal({
    title: 'Add Account',
    subtitle: 'Saved locally in data/accounts.json on this machine.',
    bodyHtml: `
      <div class="field"><label>Label</label><input name="label" required placeholder="Personal / Team / Voucher #2" /></div>
      <div class="field"><label>Novita API Key</label><input type="password" name="apiKey" required /></div>`,
    submitLabel: 'Add Account',
    onSubmit: async (fd, close) => {
      await apiRaw('/api/accounts', { method: 'POST', body: { label: fd.get('label'), apiKey: fd.get('apiKey') } });
      toast('Account added.', 'success');
      close();
      await loadAccounts();
      await refreshAccountSwitcher();
    },
  });
});

/* ---------------------------------------------------------------------- */
/* Billing                                                                */
/* ---------------------------------------------------------------------- */

async function loadBilling() {
  const statsEl = document.getElementById('billing-stats');
  statsEl.innerHTML = '<div class="stat-card">Loading…</div>';
  try {
    const b = await api('openapi/v1/billing/balance/detail');
    statsEl.innerHTML = [
      ['Available balance', money(b.availableBalance)],
      ['Cash balance', money(b.cashBalance)],
      ['Credit limit', money(b.creditLimit)],
      ['Outstanding invoices', money(b.outstandingInvoices)],
    ].map(([label, val]) => `<div class="stat-card"><div class="label">${label}</div><div class="value">${val}</div></div>`).join('');
  } catch (err) {
    statsEl.innerHTML = '';
    toast(err.message, 'error');
  }

  await loadUsage();
  await loadTransactions();
  document.getElementById('usage-category').onchange = loadUsage;
}

async function loadUsage() {
  const table = document.getElementById('tbl-usage');
  table.querySelector('thead').innerHTML = `<tr><th>Product</th><th>Category</th><th>Amount</th><th>Cash paid</th><th>Requests / usage</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 24 * 3600;
  const category = document.getElementById('usage-category').value;
  try {
    const data = await api('openapi/v1/billing/bill/list', {
      query: { cycleType: 'Day', productCategory: category, startTime: weekAgo, endTime: now },
    });
    const bills = data.bills || [];
    if (!bills.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No usage in the last 7 days for this category.</td></tr>`;
      return;
    }
    tbody.innerHTML = bills.map((b) => `
      <tr>
        <td>${escapeHtml(b.productName || '—')}</td>
        <td>${escapeHtml(b.category || '—')}</td>
        <td>${money(b.amount)}</td>
        <td>${money(b.payAmount)}</td>
        <td>${escapeHtml(b.requestCount || b.billNum0 || '—')}</td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadTransactions() {
  const table = document.getElementById('tbl-transactions');
  table.querySelector('thead').innerHTML = `<tr><th>Time</th><th>Type</th><th>Channel</th><th>Amount</th><th>Balance after</th><th>Status</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Loading…</td></tr>`;
  try {
    const data = await api('openapi/v1/bill/transaction', { query: { pageNo: 1, pageSize: 25 } });
    const rows = data.data || [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No transactions yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((t) => `
      <tr>
        <td>${unixToLocal(t.transactionTime)}</td>
        <td>${escapeHtml(t.transactionType)}</td>
        <td>${escapeHtml(t.transactionChannel || '—')}</td>
        <td>${money(t.transactionAmount)}</td>
        <td>${money(t.walletBalance)}</td>
        <td><span class="badge ${t.state === 'success' ? 'ok' : t.state === 'failed' ? 'danger' : 'warn'}">${escapeHtml(t.state)}</span></td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
  }
}

/* ---------------------------------------------------------------------- */
/* API Keys                                                               */
/* ---------------------------------------------------------------------- */

async function loadKeys() {
  const table = document.getElementById('tbl-keys');
  table.querySelector('thead').innerHTML = `<tr><th>Name</th><th>Key</th><th>Model access</th><th>Last used</th><th>Expires</th></tr>`;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;

  const data = await api('openapi/v2/user/key', { query: { includePolicySummary: true } });
  const keys = data.keys || [];
  if (!keys.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No API keys found.</td></tr>`;
    return;
  }
  tbody.innerHTML = keys.map((k) => `
    <tr>
      <td>${escapeHtml(k.name)}</td>
      <td class="mono">${escapeHtml(k.maskedKey)}</td>
      <td>${escapeHtml(k.modelAccessPolicy?.mode || '—')}</td>
      <td>${k.lastUsedAt ? unixToLocal(k.lastUsedAt) : 'never'}</td>
      <td>${escapeHtml(k.expireTime)}</td>
    </tr>`).join('');
}

/* ---------------------------------------------------------------------- */
/* Init                                                                   */
/* ---------------------------------------------------------------------- */

refreshAccountSwitcher().then(() => {
  if (hasAuth()) {
    api('openapi/v1/billing/balance/detail')
      .then(() => {
        connDot.classList.add('connected');
        if (!ACTIVE_ACCOUNT_ID) { keyStatus.textContent = 'Connected'; keyStatus.style.color = 'var(--ok)'; }
      })
      .catch(() => {
        if (!ACTIVE_ACCOUNT_ID) { keyStatus.textContent = 'Stored key failed to connect — check Settings.'; keyStatus.style.color = 'var(--danger)'; }
      });
  }
});
showPage('dashboard');
