import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    SHORTCUTS, accelerators, conflicts, keyName, matches, parseAccelerator, shortcutLabel, shortcutText,
} from '../src/lib/shortcuts.ts';

test('shortcutText', () => {
    assert.equal(shortcutText('<Shift><Control>Return'), 'Ctrl+Shift+Enter');
    assert.equal(shortcutText('<Super>space'), 'Super+Space');
    assert.equal(shortcutText('<Alt>k'), 'Alt+K');
    assert.equal(shortcutText(undefined), 'your shortcut');
});

test('parseAccelerator', () => {
    assert.deepEqual(parseAccelerator('<Shift><Control>c'), {key: 'c', ctrl: true, shift: true});
    assert.deepEqual(parseAccelerator('<Primary>Return'), {key: 'return', ctrl: true});
    assert.deepEqual(parseAccelerator('<Shift>ISO_Left_Tab'), {key: 'tab', shift: true});
    assert.deepEqual(parseAccelerator('Next'), {key: 'page_down'});
    assert.equal(parseAccelerator(''), null);
});

test('keyName matches keypad keys to the main ones', () => {
    assert.equal(keyName('KP_Enter'), 'return');
    assert.equal(keyName('KP_Up'), 'up');
    assert.equal(keyName('C'), 'c');
});

test('matches compares every modifier', () => {
    assert.ok(matches({key: 'c', ctrl: true}, {key: 'c', ctrl: true, shift: false}));
    assert.ok(!matches({key: 'c', ctrl: true}, {key: 'c', ctrl: true, shift: true}));
});

test('shortcutLabel', () => {
    assert.deepEqual(shortcutLabel({key: 'c', ctrl: true, shift: true}), ['Ctrl', '⇧', 'C']);
    assert.deepEqual(shortcutLabel({key: 'return'}), ['↵']);
    assert.deepEqual(shortcutLabel({key: 'page_down'}), ['PgDn']);
});

test('overrides replace the defaults, an empty list turns a shortcut off', () => {
    assert.deepEqual(accelerators('copy-username', {}), ['<Control>c']);
    assert.deepEqual(accelerators('copy-username', {'copy-username': ['<Alt>u']}), ['<Alt>u']);
    assert.deepEqual(accelerators('copy-username', {'copy-username': []}), []);
});

test('the defaults are valid and don\'t conflict', () => {
    for (const s of SHORTCUTS) {
        for (const a of s.defaults)
            assert.ok(parseAccelerator(a), a);
        assert.deepEqual(conflicts(s.id, {}), [], s.id);
    }
});

test('conflicts within a group and with the launcher', () => {
    assert.deepEqual(conflicts('copy-totp', {'copy-totp': ['<Control>c']}), ['copy-username']);
    assert.deepEqual(conflicts('copy-link', {'copy-link': ['<Control>k']}), ['actions']);
    // Passwords and Clockify are never shown together.
    assert.deepEqual(conflicts('stop-timer', {'stop-timer': ['<Control>l']}), []);
});
