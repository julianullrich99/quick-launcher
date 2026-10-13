/**
 * Every shortcut inside the launcher, with its defaults as GTK accelerators.
 * The settings key `launcher-shortcuts` overrides them by id; an empty list
 * turns a shortcut off. The two global shortcuts that open the launcher are
 * separate keys, because GNOME Shell binds them.
 */
export const SHORTCUTS = [
    {id: 'run', group: 'launcher', title: 'Run the main action', defaults: ['Return']},
    {id: 'actions', group: 'launcher', title: 'Show all actions', defaults: ['<Control>k']},
    {id: 'next', group: 'launcher', title: 'Select next', defaults: ['Down', 'Tab', '<Control>n']},
    {id: 'previous', group: 'launcher', title: 'Select previous', defaults: ['Up', '<Shift>Tab', '<Control>p']},
    {id: 'page-down', group: 'launcher', title: 'Page down', defaults: ['Page_Down']},
    {id: 'page-up', group: 'launcher', title: 'Page up', defaults: ['Page_Up']},
    {id: 'back', group: 'launcher', title: 'Go back or close', defaults: ['Escape']},
    {id: 'back-empty', group: 'launcher', title: 'Go back when the search is empty', defaults: ['BackSpace']},

    {id: 'copy-password', group: 'passwords', title: 'Copy password', defaults: ['<Shift><Control>c']},
    {id: 'copy-username', group: 'passwords', title: 'Copy username', defaults: ['<Control>c']},
    {id: 'type-password', group: 'passwords', title: 'Type password', defaults: ['<Shift>Return']},
    {id: 'type-login', group: 'passwords', title: 'Type username and password', defaults: ['<Control>Return']},
    {id: 'type-username', group: 'passwords', title: 'Type username', defaults: ['<Shift><Alt>u']},
    {id: 'copy-totp', group: 'passwords', title: 'Copy TOTP code', defaults: ['<Alt>t']},
    {id: 'type-totp', group: 'passwords', title: 'Type TOTP code', defaults: ['<Shift><Alt>t']},
    {id: 'sync-vaults', group: 'passwords', title: 'Sync vaults', defaults: ['<Control>r']},
    {id: 'lock-vaults', group: 'passwords', title: 'Lock vaults', defaults: ['<Control>l']},
    {id: 'vault-server', group: 'passwords', title: 'Use another Bitwarden server', defaults: ['<Control>s']},
    {id: 'vault-off', group: 'passwords', title: 'Stop using a password manager', defaults: ['<Control>d']},
    {id: 'search-passwords', group: 'passwords', title: 'Search passwords (Getting Started)', defaults: ['<Alt>p']},

    {id: 'stop-timer', group: 'clockify', title: 'Stop the running timer', defaults: ['<Control>s']},
    {id: 'reload-clockify', group: 'clockify', title: 'Reload entries', defaults: ['<Control>r']},
    {id: 'start-new', group: 'clockify', title: 'Start as a new entry', defaults: ['<Shift>Return']},
    {id: 'start-timer', group: 'clockify', title: 'Start a timer (Getting Started)', defaults: ['<Alt>t']},
    {id: 'clockify-keys', group: 'clockify', title: 'Open Clockify API keys', defaults: ['<Control>o']},
    {id: 'clockify-disconnect', group: 'clockify', title: 'Disconnect Clockify', defaults: ['<Control>d']},

    {id: 'copy-shown', group: 'calculator', title: 'Copy the answer as shown', defaults: ['<Shift><Control>c']},
    {id: 'copy-question', group: 'calculator', title: 'Copy question and answer', defaults: ['<Control><Alt>c']},

    {id: 'copy-link', group: 't3code', title: 'Copy a session link', defaults: ['<Shift><Control>c']},
] as const satisfies readonly {id: string; group: string; title: string; defaults: readonly string[]}[];

export type ShortcutId = typeof SHORTCUTS[number]['id'];
export type ShortcutGroup = typeof SHORTCUTS[number]['group'];

export const GROUPS: Record<ShortcutGroup, string> = {
    launcher: 'Launcher',
    passwords: 'Passwords',
    clockify: 'Clockify',
    calculator: 'Calculator',
    t3code: 'T3 Code',
};

/** A parsed key combination. `key` is a lowercase key name such as "c", "return" or "page_down". */
export interface Shortcut {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    super?: boolean;
}

export type Overrides = Partial<Record<string, string[]>>;

/** The accelerators of a shortcut: the user's own, or the defaults. */
export function accelerators(id: ShortcutId, overrides: Overrides): string[] {
    return overrides[id] ?? [...SHORTCUTS.find(s => s.id === id)?.defaults ?? []];
}

/** Lowercase key name; keypad keys and aliases map to the main ones. */
export function keyName(name: string): string {
    const key = name.toLowerCase().replace(/^kp_/, '');
    const aliases: Record<string, string> = {
        enter: 'return', iso_enter: 'return', iso_left_tab: 'tab',
        next: 'page_down', prior: 'page_up',
    };
    return aliases[key] ?? key;
}

/** "<Shift><Control>c" → {key: 'c', ctrl: true, shift: true} */
export function parseAccelerator(accelerator: string): Shortcut | null {
    const key = accelerator.replace(/<\w+>/g, '').trim();
    if (!key)
        return null;
    const shortcut: Shortcut = {key: keyName(key)};
    for (const [, modifier] of accelerator.matchAll(/<(\w+)>/g)) {
        const name = modifier.toLowerCase();
        if (name === 'control' || name === 'ctrl' || name === 'primary')
            shortcut.ctrl = true;
        else if (name === 'shift')
            shortcut.shift = true;
        else if (name === 'alt' || name === 'mod1')
            shortcut.alt = true;
        else if (name === 'super' || name === 'meta' || name === 'mod4')
            shortcut.super = true;
    }
    return shortcut;
}

export function matches(a: Shortcut, b: Shortcut): boolean {
    return a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift &&
        !!a.alt === !!b.alt && !!a.super === !!b.super;
}

const KEY_LABELS: Record<string, string> = {
    return: '↵', escape: 'Esc', backspace: '⌫', delete: 'Del', tab: 'Tab', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→', page_up: 'PgUp', page_down: 'PgDn', home: 'Home', end: 'End',
};

/** Key caps for the launcher: ['Ctrl', '⇧', 'C'] */
export function shortcutLabel(s: Shortcut): string[] {
    const key = KEY_LABELS[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1));
    return [
        ...s.super ? ['Super'] : [],
        ...s.ctrl ? ['Ctrl'] : [],
        ...s.alt ? ['Alt'] : [],
        ...s.shift ? ['⇧'] : [],
        key,
    ];
}

/** "<Shift><Control>Return" → "Ctrl+Shift+Enter" */
export function shortcutText(accelerator: string | undefined): string {
    const s = accelerator ? parseAccelerator(accelerator) : null;
    if (!s)
        return 'your shortcut';
    const names: Record<string, string> = {return: 'Enter', escape: 'Esc', backspace: 'Backspace', page_up: 'Page Up', page_down: 'Page Down'};
    const key = names[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1));
    return [
        ...s.super ? ['Super'] : [],
        ...s.ctrl ? ['Ctrl'] : [],
        ...s.alt ? ['Alt'] : [],
        ...s.shift ? ['Shift'] : [],
        key,
    ].join('+');
}

/**
 * Other shortcuts with the same keys that can be active at the same time:
 * those in the same group, and every launcher shortcut.
 */
export function conflicts(id: ShortcutId, overrides: Overrides): ShortcutId[] {
    const group = SHORTCUTS.find(s => s.id === id)?.group;
    const mine = accelerators(id, overrides).map(parseAccelerator).filter(s => s !== null);
    return SHORTCUTS
        .filter(s => s.id !== id && (s.group === group || s.group === 'launcher' || group === 'launcher'))
        .filter(s => accelerators(s.id, overrides).some(a => {
            const other = parseAccelerator(a);
            return other && mine.some(m => matches(m, other));
        }))
        .map(s => s.id);
}
