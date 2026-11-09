// No browser/backend required. Run: node scripts/test-orbit.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../lib/orbit.ts');
const compiled = new Module(file, module);
compiled._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const { orbitTracks } = compiled.exports;
const e = (id, start, end, allDay = false) => ({ id, start, end, allDay });

assert.deepEqual(orbitTracks([]), []);
assert.equal(orbitTracks([e('all', '00:00', '23:59', true)]).length, 0);
const adjacent = orbitTracks([e('b', '10:00', '11:00'), e('a', '09:00', '10:00')]);
assert.deepEqual(adjacent.map(t => t.lane), [0, 0]);
const nested = orbitTracks([e('long', '08:00', '20:00'), e('a', '09:00', '10:00'), e('b', '10:00', '11:00')]);
assert.deepEqual(nested.map(t => t.lane), [0, 1, 1]);
const crowd = orbitTracks(Array.from({ length: 13 }, (_, i) => e(String(i), '09:00', '12:00')));
assert.equal(new Set(crowd.map(t => t.lane)).size, 13);
assert.equal(Math.ceil((Math.max(...crowd.map(t => t.lane)) + 1) / 4), 4);
assert.equal(orbitTracks([e('night', '23:00', '01:00')])[0].end, 1440);

// Deterministic stress case: every pair on a shared lane must be disjoint.
const time = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const many = orbitTracks(Array.from({ length: 300 }, (_, i) => {
  const start = (i * 47) % 1200;
  return e(String(i), time(start), time(Math.min(start + (i * 31) % 239 + 1, 1439)));
}));
for (let i = 0; i < many.length; i++) for (let j = i + 1; j < many.length; j++) {
  if (many[i].lane === many[j].lane) assert.ok(many[i].end <= many[j].start);
}
console.log('PASS: empty, all-day, adjacency, nested duration, 13 overlaps, overnight and 300-event stress case.');
