import assert from 'node:assert/strict';
import {test} from 'node:test';

import {normalizeServer} from '../src/passwords/server.ts';

test('normalizeServer', () => {
    assert.equal(normalizeServer(''), '');
    assert.equal(normalizeServer('  bitwarden.com '), '');
    assert.equal(normalizeServer('https://vault.bitwarden.com/'), '');
    assert.equal(normalizeServer('vault.bitwarden.eu'), 'https://vault.bitwarden.eu');
    assert.equal(normalizeServer('https://vault.example.com/'), 'https://vault.example.com');
    assert.equal(normalizeServer('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
});
