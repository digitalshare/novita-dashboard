'use strict';

const fs = require('fs');
const path = require('path');

// Novita's sandbox API has no rename or metadata-update endpoint at all —
// /sandboxes/{id} only supports GET and DELETE (verified against its raw
// OpenAPI spec). metadata.name (set in sandboxLib.createSandbox) is fixed
// for the sandbox's whole life. So an editable name has to live entirely on
// our side: this file is the source of truth once a sandbox has been
// renamed, and it wins over metadata.name wherever both exist. Lives next to
// data/accounts.json, so it rides the same persistent volume when deployed.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sandbox-names.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
}

function getName(sandboxId) {
  return load()[sandboxId];
}

function findBySandboxName(name) {
  const map = load();
  return Object.keys(map).find((id) => map[id] === name);
}

function setName(sandboxId, name) {
  const map = load();
  if (name) map[sandboxId] = name;
  else delete map[sandboxId];
  save(map);
}

function forget(sandboxId) {
  const map = load();
  if (sandboxId in map) {
    delete map[sandboxId];
    save(map);
  }
}

module.exports = { getName, findBySandboxName, setName, forget };
