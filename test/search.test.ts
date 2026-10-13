import assert from 'node:assert/strict';
import {test} from 'node:test';

import {normalize, SearchIndex, type Field} from '../src/lib/search.ts';

interface Item {
    name: string;
    user?: string;
}

const fields = (item: Item): Field[] => [[10, item.name], [5, item.user]];

test('normalize strips accents and case', () => {
    assert.equal(normalize('Ünïcödé'), 'unicode');
});

test('empty query returns everything in order', () => {
    const index = new SearchIndex([{name: 'b'}, {name: 'a'}], fields);
    assert.deepEqual(index.search('  ').map(i => i.name), ['b', 'a']);
});

test('items matching more tokens rank first', () => {
    const index = new SearchIndex([
        {name: 'GitHub', user: 'work@example.com'},
        {name: 'GitLab', user: 'me@example.com'},
        {name: 'GitHub', user: 'me@example.com'},
    ], fields);
    const results = index.search('github me');
    assert.deepEqual(results.map(i => `${i.name} ${i.user}`), [
        'GitHub me@example.com',
        'GitHub work@example.com',
        'GitLab me@example.com',
    ]);
});

test('exact and prefix matches beat substrings', () => {
    const index = new SearchIndex([{name: 'mygit'}, {name: 'gitea'}, {name: 'git'}], fields);
    assert.deepEqual(index.search('git').map(i => i.name), ['git', 'gitea', 'mygit']);
});

test('all: only items matching every word', () => {
    const index = new SearchIndex([{name: 'AWS Console', user: 'infra'}, {name: 'GitHub'}], fields);
    assert.deepEqual(index.search('2 min in year', {all: true}), []);
    assert.deepEqual(index.search('aws in', {all: true}).map(i => i.name), ['AWS Console']);
});
