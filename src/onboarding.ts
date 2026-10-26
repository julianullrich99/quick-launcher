import Gio from 'gi://Gio';

import {shortcutText, type ShortcutId} from './lib/shortcuts.ts';
import type {Action, Item, Launcher, Section, View} from './lib/launcher.ts';
import {notifyError, osd} from './lib/output.ts';
import type {Passwords, VaultInfo} from './passwords/passwords.ts';
import {PASSWORDS_COLOR} from './passwords/passwords.ts';
import type {T3Code} from './t3code/t3code.ts';
import type {TimeTracking} from './timer/tracking.ts';

const ACCENT = '#3584e4';

export interface OnboardingProviders {
    settings: Gio.Settings;
    launcher: Launcher;
    passwords: Passwords;
    tracking: TimeTracking;
    t3code: T3Code;
    /** The start view, which searches while typing here and opens when done */
    root: View;
}

/**
 * Getting started, shown on the first open: connect password managers and
 * time tracking, then try the calculator, emoji and commands with examples.
 */
export class Onboarding {
    readonly #p: OnboardingProviders;
    readonly view: View;

    constructor(providers: OnboardingProviders) {
        this.#p = providers;
        this.view = {
            title: 'Getting Started',
            icon: 'starred-symbolic',
            placeholder: 'Welcome! Connect your accounts, or just start typing…',
            search: query => query.trim() ? this.#p.root.search(query) : this.#sections(),
            onOpen: () => this.#p.settings.set_boolean('onboarding-done', true),
        };
    }

    /** Not shown yet: the first open starts here. */
    get pending(): boolean {
        return !this.#p.settings.get_boolean('onboarding-done');
    }

    command(): Item {
        return {
            id: 'command:onboarding',
            icon: {name: 'starred-symbolic', color: ACCENT},
            title: 'Getting Started',
            subtitle: 'Connect password managers and time tracking, see what Quick Launcher can do',
            accessory: 'Command',
            keywords: 'welcome onboarding setup connect einrichten willkommen',
            actions: [{title: 'Open', icon: 'go-next-symbolic', run: () => this.#p.launcher.push(this.view)}],
        };
    }

    #sections(): Section[] {
        const {passwords, t3code} = this.#p;
        return [
            {title: 'Connect', items: [
                ...passwords.vaults().map(info => this.#vaultRow(info)),
                this.#trackingRow(),
                ...t3code.available ? [this.#t3Row()] : [],
            ]},
            {title: 'Try it', items: this.#examples()},
            {items: [{
                id: 'onboarding:done',
                icon: {name: 'go-next-symbolic', color: ACCENT},
                title: 'Start Using Quick Launcher',
                subtitle: `Open it any time with ${shortcutText(this.#p.settings.get_strv('open-shortcut')[0])}`,
                actions: [{title: 'Start', icon: 'go-next-symbolic', run: () => this.#p.launcher.open(this.#p.root)}],
            }]},
        ];
    }

    #vaultRow({vault, logo, status, error, items, server}: VaultInfo): Item {
        const base = {id: `onboarding:${vault.id}`, icon: {gicon: logo, color: vault.color}};
        const turnOff: Action = {
            title: `Don’t Use ${vault.name}`, icon: 'process-stop-symbolic', shortcut: 'vault-off',
            run: () => this.#p.passwords.setEnabled(vault, false),
        };
        const changeServer: Action[] = vault.askServer ? [{
            title: 'Use Another Server…', icon: 'network-server-symbolic', shortcut: 'vault-server',
            run: () => void this.#p.passwords.changeServer(vault),
        }] : [];
        const host = server.replace(/^[a-z]+:\/\//i, '');
        const keys = (id: ShortcutId) => this.#p.launcher.keyText(id);

        if (!vault.installed) {
            return {
                ...base,
                title: vault.name,
                subtitle: vault.id === 'bitwarden' ? 'Needs rbw, a Bitwarden command line client' : 'Needs the 1Password CLI',
                accessory: 'Not installed',
                dim: true,
                actions: [{title: 'Open Install Guide', icon: 'web-browser-symbolic', run: () => this.#openUri(vault.website)}],
            };
        }
        if (vault.enabled && status === 'unlocked') {
            return {
                ...base,
                title: vault.name,
                subtitle: [`${items} items`, host, copyHint(keys('run'), keys('copy-password'), keys('copy-username'))]
                    .filter(Boolean).join(' · '),
                accessory: '✓ Connected',
                accessoryActive: true,
                actions: [
                    {title: 'Search Passwords', icon: 'system-search-symbolic', run: () => this.#p.launcher.push(this.#p.passwords.view)},
                    ...changeServer,
                    turnOff,
                ],
            };
        }

        const connect = {title: 'Connect', icon: 'system-lock-screen-symbolic', run: () => void this.#p.passwords.connect(vault)};
        if (!vault.enabled)
            return {...base, title: `Connect ${vault.name}`, subtitle: 'Turned off', dim: true, actions: [connect]};
        if (status === 'unlocking')
            return {...base, title: `Connecting ${vault.name}…`, dim: true, actions: [connect]};
        return {
            ...base,
            title: `Connect ${vault.name}`,
            subtitle: status === 'error' ? error : vault.id === 'bitwarden'
                ? [`Through rbw${host ? ` · ${host}` : ''}`, `self-hosted works too${keys('vault-server') ? `, ${keys('vault-server')}` : ''}`].join(' · ')
                : 'Through the 1Password app or your master password',
            accessory: status === 'error' ? 'Failed' : undefined,
            actions: [connect, ...changeServer, turnOff],
        };
    }

    /** "Connect Clockify" (or the custom server) for the start view's commands, until it is connected. */
    trackingCommand(): Item | null {
        const {tracking} = this.#p;
        if (tracking.configured && !tracking.error)
            return null;
        return {
            ...this.#trackingRow(),
            id: 'command:clockify-connect',
            accessory: tracking.error ? 'Failed' : 'Set Up',
            keywords: `${tracking.name} clockify timer time tracking zeiterfassung api key token anmelden verbinden`,
        };
    }

    #trackingRow(): Item {
        const {tracking, launcher, settings} = this.#p;
        const {name, service} = tracking;
        const base = {id: 'onboarding:clockify', icon: {name: 'alarm-symbolic', color: tracking.color}};
        const custom = settings.get_string('time-tracker') === 'custom';
        const other: Action = {
            title: custom ? 'Use Clockify Instead' : 'Use a Custom Server Instead', icon: 'network-server-symbolic',
            run: () => settings.set_string('time-tracker', custom ? 'clockify' : 'custom'),
        };
        const openKeys: Action[] = service.keysUrl ? [{
            title: `Open ${name} API Keys`, icon: 'web-browser-symbolic', shortcut: 'clockify-keys',
            run: () => this.#openUri(service.keysUrl!),
        }] : [];

        if (tracking.configured && !tracking.error) {
            return {
                ...base,
                title: name,
                subtitle: 'Type what you work on and press Enter to start a timer',
                accessory: '✓ Connected',
                accessoryActive: true,
                actions: [
                    {title: 'Start Timer', icon: 'media-playback-start-symbolic', run: () => launcher.push(tracking.view)},
                    {title: 'Disconnect', icon: 'process-stop-symbolic', destructive: true, shortcut: 'clockify-disconnect', run: () => tracking.disconnect()},
                ],
            };
        }
        return {
            ...base,
            title: `Connect ${name}`,
            subtitle: tracking.error ?? `Start timers from your recent entries · needs ${custom ? 'a server and a token' : 'an API key'}`,
            accessory: tracking.error ? 'Failed' : undefined,
            actions: [
                {title: `Enter ${capitalize(service.keyName)}`, icon: 'dialog-password-symbolic', run: () => void this.#connectTracking()},
                ...openKeys,
                other,
            ],
        };
    }

    async #connectTracking() {
        const {launcher, tracking, settings} = this.#p;
        const {missing} = tracking.service;
        if (missing) {
            const value = (await launcher.ask({...missing, secret: false, action: 'Next'}))?.trim();
            if (!value)
                return;
            settings.set_string(missing.setting, value);
        }
        const {name, service} = tracking;
        const key = (await launcher.ask({
            prompt: `${name} ${service.keyName}`,
            description: service.keyHint,
            action: 'Connect',
        }))?.trim();
        if (!key)
            return;
        launcher.setStatus(`Checking the ${service.keyName}…`);
        try {
            const account = await tracking.connect(key);
            launcher.setStatus(null);
            osd('alarm-symbolic', `${name} connected as ${account}`);
        } catch (e) {
            launcher.setStatus(`${name}: ${(e as Error).message}`);
        }
    }

    #t3Row(): Item {
        const {t3code, launcher} = this.#p;
        const command = t3code.command();
        return {
            id: 'onboarding:t3code',
            icon: command?.icon ?? {name: 'utilities-terminal-symbolic'},
            title: 'T3 Code',
            subtitle: 'Active sessions show up in the search, with whether the agent is working',
            accessory: '✓ Found',
            accessoryActive: true,
            actions: [{title: 'Search Sessions', icon: 'system-search-symbolic', run: () => launcher.push(t3code.view)}],
        };
    }

    #examples(): Item[] {
        const {launcher, root, passwords, tracking} = this.#p;
        const example = (id: string, icon: string, color: string, title: string, subtitle: string, query: string): Item => ({
            id: `onboarding:example-${id}`,
            icon: {name: icon, color},
            title,
            subtitle,
            accessory: query,
            actions: [{title: `Try “${query}”`, icon: 'go-next-symbolic', run: () => launcher.open(root, {query})}],
        });
        return [
            example('calc', 'accessories-calculator-symbolic', '#ff7800', 'Calculator',
                'Math, units, currencies and percentages', '100 usd in eur'),
            example('units', 'accessories-calculator-symbolic', '#ff7800', 'Units',
                'Any unit into any other, in English or German', '2 min in year'),
            example('dates', 'x-office-calendar-symbolic', '#e66100', 'Dates',
                'Countdowns, calendar weeks and relative dates', 'days until 24.12.'),
            example('time', 'preferences-system-time-symbolic', '#e66100', 'Time Zones',
                'The time anywhere, and conversions between zones', 'time in tokyo'),
            example('emoji', 'face-smile-symbolic', '#e5a50a', 'Emoji',
                'Start with a colon; English and German names', ':rocket'),
            example('system', 'system-shutdown-symbolic', '#6f6f78', 'System Commands',
                'Lock, suspend, dark mode, Do Not Disturb, Night Light…', 'lock'),
            {
                id: 'onboarding:example-actions',
                icon: {name: 'view-more-symbolic', color: PASSWORDS_COLOR},
                title: 'More Actions',
                subtitle: `${launcher.keyText('actions') || 'The action panel'} lists every action of the selected item, with its shortcut`,
                accessory: launcher.keyText('actions'),
                actions: [
                    {title: 'Show Actions', icon: 'view-more-symbolic', run: () => launcher.showActions()},
                    {title: 'Search Passwords', icon: 'dialog-password-symbolic', shortcut: 'search-passwords', run: () => launcher.push(passwords.view)},
                    ...tracking.configured
                        ? [{title: 'Start Timer', icon: 'alarm-symbolic', shortcut: 'start-timer', run: () => launcher.push(tracking.view)} satisfies Action]
                        : [],
                ],
            },
        ];
    }

    #openUri(uri: string) {
        this.#p.launcher.close();
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            notifyError(`Could not open ${uri}`, e);
        }
    }
}

/** "Enter or Ctrl+Shift+C copies a password, Ctrl+C the username", for the keys that are set */
function copyHint(run: string, password: string, username: string): string {
    const passwordKeys = [run, password].filter(Boolean).join(' or ');
    return [
        passwordKeys && `${passwordKeys} copies a password`,
        username && `${username} the username`,
    ].filter(Boolean).join(', ');
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
