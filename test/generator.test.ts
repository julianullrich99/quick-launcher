import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';

import {DIGITS, generate, LOWER, SYMBOLS, UPPER} from '../src/passwords/generator.ts';

const classes = [LOWER, UPPER, DIGITS, SYMBOLS];

test('has the length and a character of every class', () => {
    for (let i = 0; i < 200; i++) {
        const password = generate(8, classes, n => randomBytes(n));
        assert.equal(password.length, 8);
        for (const c of classes)
            assert.ok([...password].some(char => c.includes(char)), `${password} lacks one of ${c}`);
    }
});

test('rejects bytes that would bias the result', () => {
    // 10 digits: bytes 250-255 would make 0-5 more likely, so they are skipped.
    const bytes = [255, 250, 7, 249];
    let next = 0;
    assert.equal(generate(2, [DIGITS], () => Uint8Array.of(bytes[next++])), '79');
});
