'use strict';
const fs = require('fs');
const path = require('path');

class Reminders {
    constructor(userDataDir) {
        this.file = path.join(userDataDir, 'reminders.json');
        this.data = this._load();
    }
    _load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(raw)) return raw;
        } catch (e) { }
        // Default fallback
        return [{ id: 'demo', title: 'Drink Water', type: 'hydration', schedule: 'manual', actions: ['completed', 'postponed'] }];
    }
    _save() {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
    }
    getAll() {
        return this.data;
    }
    saveAll(reminders) {
        // Cap at 4
        this.data = reminders.slice(0, 4);
        this._save();
    }
}
module.exports = { Reminders };
