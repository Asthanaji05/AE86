'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MISSED_AFTER_MS = 10 * 60 * 1000;
const MAX_EVENTS = 50000;

class Analytics {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'analytics.json');
    this.data = this._load();
    this._lastKey = null;
  }
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.version === VERSION && Array.isArray(raw.events)) return raw;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const bak = `${this.file}.corrupt.${Date.now()}.json`;
        try { fs.renameSync(this.file, bak); console.warn('analytics: corrupt file moved to', bak); } catch { }
      }
    }
    return { version: VERSION, events: [], settings: { retentionDays: 90 } };
  }
  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  log(rec) {
    const type = typeof rec.type === 'string' && rec.type ? rec.type.slice(0, 64) : 'default';
    const validStatuses = ['completed', 'postponed', 'missed', 'pending', 'snoozed', 'skipped', 'custom'];
    const status = validStatuses.includes(rec.status) ? rec.status : 'pending';
    const triggeredAt = Number.isFinite(rec.triggeredAt) ? rec.triggeredAt : Date.now();
    const respondedAt = Number.isFinite(rec.respondedAt) ? rec.respondedAt : null;
    const responseMs = respondedAt != null ? Math.max(0, respondedAt - triggeredAt) : null;
    const key = `${type}|${triggeredAt}`;

    if (key === this._lastKey) return;
    this._lastKey = key;

    this.data.events.push({ id: `r_${triggeredAt}_${Math.random().toString(36).slice(2, 6)}`, type, status, triggeredAt, respondedAt, responseMs });
    this._prune();
    try { this._save(); } catch (e) { console.error('analytics: write failed', e.message); }
  }
  _prune() {
    const cutoff = Date.now() - (this.data.settings.retentionDays || 90) * 86400000;
    const kept = this.data.events.filter((e) => e.triggeredAt >= cutoff);
    while (kept.length > MAX_EVENTS) kept.shift();
    this.data.events = kept;
  }
  snapshot() {
    const now = Date.now();
    return {
      version: VERSION,
      settings: this.data.settings,
      events: this.data.events.map((e) =>
        e.status === 'pending' && e.triggeredAt < now - MISSED_AFTER_MS ? { ...e, status: 'missed' } : e),
    };
  }
}
module.exports = { Analytics };
