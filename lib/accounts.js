'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(accounts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(accounts, null, 2));
}

function mask(key) {
  if (!key || key.length < 8) return '****';
  return `${key.slice(0, 6)}${'*'.repeat(Math.max(4, key.length - 10))}${key.slice(-4)}`;
}

function toPublic(acct) {
  return { id: acct.id, label: acct.label, maskedKey: mask(acct.apiKey), createdAt: acct.createdAt };
}

function listAccounts() {
  return load().map(toPublic);
}

function addAccount(label, apiKey) {
  if (!label || !label.trim()) throw new Error('Account label is required.');
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required.');
  const accounts = load();
  const acct = { id: crypto.randomUUID(), label: label.trim(), apiKey: apiKey.trim(), createdAt: Date.now() };
  accounts.push(acct);
  save(accounts);
  return toPublic(acct);
}

function removeAccount(id) {
  const accounts = load();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) throw new Error('Account not found.');
  save(next);
  return { id, removed: true };
}

function getApiKey(id) {
  const acct = load().find((a) => a.id === id);
  if (!acct) throw new Error('Unknown account. It may have been removed.');
  return acct.apiKey;
}

module.exports = { listAccounts, addAccount, removeAccount, getApiKey };
