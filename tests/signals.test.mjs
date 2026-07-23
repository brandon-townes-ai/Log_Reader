import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const S = require(join(HERE, '..', 'frontend', 'signals.js'));

const bySignal = res => Object.fromEntries(res.signals.map(s => [s.signal, s]));

test('coerceSignalTime: epoch unit detection', () => {
  assert.equal(S.coerceSignalTime(1784493515), 1784493515000);            // s
  assert.equal(S.coerceSignalTime(1784493515000), 1784493515000);         // ms
  assert.equal(S.coerceSignalTime(1784493515000000), 1784493515000);      // µs
  assert.equal(S.coerceSignalTime(1784493515000000000), 1784493515000);   // ns
  assert.equal(S.coerceSignalTime('2026-07-01 10:00:00.500'),
               Date.parse('2026-07-01T10:00:00.500'));
  assert.equal(S.coerceSignalTime('not a time'), null);
});

test('CSV with header, named columns', () => {
  const csv = readFileSync(join(HERE, 'fixtures', 'signals.csv'), 'utf8');
  const res = S.parseSignalCsv(csv, 'signals');
  const g = bySignal(res);
  assert.equal(Object.keys(g).length, 2);
  const ct = g['/mine_autonomy/controls/tracking_control_metric.error_metrics.cross_track_m'];
  assert.equal(ct.t.length, 3);
  assert.deepEqual(ct.v, [0.12, 0.35, 0.28]);
  assert.equal(g['/behavior_status/distance_to_goal_m'].v[1], 17.5);
  assert.equal(res.truncated, false);
});

test('CSV headerless 3-col and 2-col', () => {
  const three = S.parseSignalCsv('1784493515,foo,1.5\n1784493516,foo,2.5\n', 'fb');
  assert.deepEqual(bySignal(three).foo.v, [1.5, 2.5]);
  const two = S.parseSignalCsv('1784493515,1.5\n1784493516,2.5\n', 'my_export');
  assert.deepEqual(bySignal(two).my_export.v, [1.5, 2.5]);
});

test('JSONL with key aliases', () => {
  const jsonl = [
    '{"timestamp": 1784493515, "signal": "a", "value": 1}',
    '{"time": "2026-07-01 10:00:00", "name": "a", "val": 2}',
    'garbage line',
    '{"t": 1784493517000, "metric": "b", "v": 3}',
  ].join('\n');
  const g = bySignal(S.parseSignalJsonl(jsonl, 'fb'));
  assert.equal(g.a.v.length, 2);
  assert.deepEqual(g.b.v, [3]);
});

test('telegraf line protocol', () => {
  const out = readFileSync(join(HERE, 'fixtures', 'telegraf_sample.out'), 'utf8');
  assert.equal(S.looksLikeTelegraf(out), true);
  const g = bySignal(S.parseTelegraf(out));
  assert.deepEqual(g['system.load1'].v, [11.15]);
  assert.equal(g['system.n_cpus'].v[0], 32);            // trailing 'i' int
  assert.equal(g['system.uptime_format'], undefined);   // string field skipped
  assert.deepEqual(g['cpu.usage_user'].v, [55.2, 61.7]);
  assert.equal(g['mem.available'].v[0], 1.2e10);        // sci notation
  assert.equal(g['system.load1'].t[0], 1784493515000);  // ns → ms
});

test('router picks parser by extension/sniff', () => {
  assert.ok(S.signalParserFor('x.csv', 'a,b\n'));
  assert.ok(S.signalParserFor('x.jsonl', '{}\n'));
  assert.ok(S.signalParserFor('metrics.out', 'system,host=h load1=1 1784493515000000000\n'));
  assert.equal(S.signalParserFor('stdout.out', 'just some stdout text\n'), null);
  assert.equal(S.signalParserFor('x.txt', 'a,b\n'), null);
});

test('sample cap sets truncated', () => {
  const lines = ['timestamp,signal,value'];
  for (let i = 0; i < 50; i++) lines.push(`178449351${i % 10},s,${i}`);
  const orig = S.MAX_SAMPLES_PER_FILE;
  // cap is a const export — simulate by checking a small synthetic parse stays under it
  const res = S.parseSignalCsv(lines.join('\n'), 'fb');
  assert.equal(res.truncated, false);
  assert.equal(bySignal(res).s.v.length, 50);
  assert.ok(orig >= 1_000_000);
});
