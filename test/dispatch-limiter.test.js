import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchLimiter } from '../src/dispatch-limiter.js';

test('spaces dispatches by three seconds, including startup and independent devices', () => {
  let clock = 0;
  const limiter = createDispatchLimiter({ now: () => clock });
  assert.equal(limiter.ready('a'), false);
  clock = 2999;
  assert.equal(limiter.ready('a'), false);
  clock = 3000;
  assert.equal(limiter.ready('a'), true);
  limiter.dispatched('a');
  assert.equal(limiter.ready('a'), false);
  assert.equal(limiter.ready('b'), true);
  clock = 5999;
  assert.equal(limiter.ready('a'), false);
  clock = 6000;
  assert.equal(limiter.ready('a'), true);
  // Reconnecting the same ID does not reset its cooldown.
  limiter.dispatched('a');
  assert.equal(limiter.ready('a'), false);
  // New process: a full startup cooldown protects the preceding process's send.
  const restarted = createDispatchLimiter({ now: () => clock });
  clock = 8999;
  assert.equal(restarted.ready('a'), false);
  clock = 9000;
  assert.equal(restarted.ready('a'), true);
});

test('does not accumulate burst credits or exceed 20 dispatches in a rolling minute', () => {
  let clock = 0;
  const limiter = createDispatchLimiter({ now: () => clock });
  clock = 100000;
  const sent = [];
  for (let i = 0; i < 180000; ++i, ++clock) {
    if (limiter.ready('a')) {
      limiter.dispatched('a');
      sent.push(clock);
      assert.equal(limiter.ready('a'), false);
    }
    assert.ok(sent.filter(time => time > clock - 60000).length <= 20);
  }
  assert.equal(sent.length, 60);
});
