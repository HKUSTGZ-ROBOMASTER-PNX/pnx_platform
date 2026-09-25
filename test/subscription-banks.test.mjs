import test from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionBanks } from '../src/subscription-banks.mjs';

test('rotates all requested IDs through the DAP wire limit and stops cleanly', async () => {
  const calls = [];
  const errors = [];
  const session = { closed: false, async subscribe(ids, rate) { calls.push({ ids, rate }); } };
  const banks = new SubscriptionBanks(message => errors.push(message), 2, 10);
  try {
    assert.deepEqual(await banks.set(session, ['a', 'b', 'c', 'd', 'e'], 1000), { banks: 3, bankSize: 2, dwellMs: 10 });
    const deadline = Date.now() + 1000;
    while (calls.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls.slice(0, 3).map(call => call.ids), [['a', 'b'], ['c', 'd'], ['e']]);
    assert.ok(calls.every(call => call.rate === 1000));
    assert.deepEqual(errors, []);
  } finally { banks.stop(); }
  const count = calls.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, count);
});

test('large selections cover every channel without exceeding the DAP limit', async () => {
  const ids = Array.from({ length: 10000 }, (_, index) => `channel-${index}`);
  const calls = [];
  const session = { closed: false, async subscribe(bank) { calls.push(bank); } };
  const subscriptions = new SubscriptionBanks(() => {}, 256, 1);
  try {
    const rotation = await subscriptions.set(session, ids, 1000);
    assert.equal(rotation.banks, 40);
    const deadline = Date.now() + 3000;
    while (calls.length < 40 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls.length >= 40, true);
    assert.ok(calls.every(bank => bank.length <= 256));
    assert.deepEqual(calls.slice(0, 40).flat(), ids);
  } finally { subscriptions.stop(); }
});

test('replacement subscription waits for the previous DAP write', async () => {
  const calls = [];
  let releaseFirst;
  const session = { closed: false, async subscribe(ids) {
    calls.push(ids);
    if (calls.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
  } };
  const subscriptions = new SubscriptionBanks(() => {}, 256, 10);
  try {
    const first = subscriptions.set(session, ['old'], 1000);
    const deadline = Date.now() + 1000;
    while (!releaseFirst && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof releaseFirst, 'function');
    const second = subscriptions.set(session, ['new'], 1000);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, [['old']]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(calls, [['old'], ['new']]);
  } finally { subscriptions.stop(); }
});
