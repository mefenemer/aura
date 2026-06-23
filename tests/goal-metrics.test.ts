// tests/goal-metrics.test.ts
// SMART Goals — the metric catalog (src/config/goal-metrics.ts) gates the Goal Builder dropdown
// (AC1.1.2) and connection-validation (AC1.1.3). Lock its behaviour so additions can't break it.
// Run:  npx tsx tests/goal-metrics.test.ts

import assert from 'node:assert';
import {
    GOAL_METRICS,
    getGoalMetric,
    isValidMetricKey,
    availableMetricsForConnections,
    GOAL_STATUSES,
} from '../src/config/goal-metrics';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('every metric key is unique', () => {
    const keys = GOAL_METRICS.map(m => m.key);
    assert.equal(new Set(keys).size, keys.length);
});

check('connection metrics declare their required service', () => {
    for (const m of GOAL_METRICS) {
        if (m.source === 'connection') assert.ok(m.connectionService, `${m.key} missing connectionService`);
    }
});

check('getGoalMetric / isValidMetricKey', () => {
    assert.equal(getGoalMetric('instagram_followers')?.label, 'Instagram Followers');
    assert.equal(getGoalMetric('nope'), undefined);
    assert.equal(isValidMetricKey('qualified_leads'), true);
    assert.equal(isValidMetricKey('made_up'), false);
});

check('AC1.1.3 — internal metrics always available, connection metrics gated', () => {
    const none = availableMetricsForConnections([]).map(m => m.key);
    assert.ok(none.includes('qualified_leads'), 'internal metric should always be available');
    assert.ok(!none.includes('instagram_followers'), 'IG metric hidden when not connected');

    const withIg = availableMetricsForConnections(['instagram']).map(m => m.key);
    assert.ok(withIg.includes('instagram_followers'), 'IG metric available once connected');
    assert.ok(withIg.includes('qualified_leads'));

    // case-insensitive service matching
    assert.ok(availableMetricsForConnections(['INSTAGRAM']).map(m => m.key).includes('instagram_reach'));
});

check('status model includes the four tracked states + pending', () => {
    for (const s of ['pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected'])
        assert.ok(GOAL_STATUSES.includes(s as any), s);
});

console.log(`\n${passed} checks passed.`);
