import assert from 'node:assert/strict';
import {test} from 'node:test';

import {distinctTasks, duration, parseDraft, serverTasks, timeAgo} from '../src/timer/tasks.ts';

const projects = [
    {id: 'p1', name: 'Falcon Website', clientName: 'Falcon', color: '#f00', billable: true},
    {id: 'p2', name: 'Internal'},
];
const tags = [{id: 't1', name: 'Meeting'}, {id: 't2', name: 'Code Review'}];

test('parseDraft picks the first matching project and tags', () => {
    const draft = parseDraft('Standup @falcon #meet #codereview #nope', projects, tags);
    assert.equal(draft.description, 'Standup #nope');
    assert.equal(draft.project?.id, 'p1');
    assert.deepEqual(draft.tags.map(t => t.id), ['t1', 't2']);
});

test('parseDraft keeps a second @ as text', () => {
    const draft = parseDraft('@int @falcon fix', projects, tags);
    assert.equal(draft.project?.id, 'p2');
    assert.equal(draft.description, '@falcon fix');
});

test('distinctTasks de-duplicates and keeps the newest first', () => {
    const tasks = distinctTasks([
        {description: 'Review', projectId: 'p1', tagIds: ['t2'], timeInterval: {start: '2026-10-12T10:00:00Z', end: null}},
        {description: 'Review', projectId: 'p1', tagIds: ['t2'], timeInterval: {start: '2026-10-11T10:00:00Z', end: '2026-10-11T11:00:00Z'}},
        {description: 'Review', projectId: 'p2', timeInterval: {start: '2026-10-10T10:00:00Z', end: '2026-10-10T11:00:00Z'}},
    ], projects, tags);

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].running, true);
    assert.equal(tasks[0].projectName, 'Falcon Website');
    assert.deepEqual(tasks[0].tagNames, ['Code Review']);
    assert.equal(tasks[1].running, false);
    assert.equal(tasks[1].projectName, 'Internal');
});

test('serverTasks puts the running entry first, once', () => {
    const review = {description: 'Review', taskId: 'g1', task: {name: 'Login', project: 'Web › Phase 2'}, categoryId: 'c1', category: {name: 'Project work', color: '#1baf7a'}};
    const tasks = serverTasks([
        {...review, lastUsedAt: '2026-10-12T09:00:00Z'},
        {description: 'Admin', projectId: 'p1', project: 'Internal', lastUsedAt: '2026-10-11T09:00:00Z'},
    ], {...review, startedAt: '2026-10-12T10:00:00Z'});

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].running, true);
    assert.equal(tasks[0].lastStart, '2026-10-12T10:00:00Z');
    assert.equal(tasks[0].projectName, 'Web › Phase 2');
    assert.equal(tasks[0].taskName, 'Login');
    assert.deepEqual(tasks[0].tagIds, ['c1']);
    assert.deepEqual(tasks[0].tagNames, ['Project work']);
    assert.equal(tasks[0].color, '#1baf7a');
    assert.equal(tasks[1].running, false);
    assert.equal(tasks[1].projectName, 'Internal');
    assert.equal(serverTasks([{description: 'Admin'}], null)[0].running, false);
});

test('timeAgo and duration', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    assert.equal(timeAgo('2026-10-12T11:59:30Z', now), 'now');
    assert.equal(timeAgo('2026-10-12T11:15:00Z', now), '45m');
    assert.equal(timeAgo('2026-10-12T09:00:00Z', now), '3h');
    assert.equal(timeAgo('2026-10-11T09:00:00Z', now), 'yesterday');
    assert.equal(timeAgo('2026-10-08T12:00:00Z', now), '4d');
    assert.equal(timeAgo('2026-09-01T12:00:00Z', now), '5w');
    assert.equal(duration('2026-10-12T10:37:00Z', now), '1:23');
});
