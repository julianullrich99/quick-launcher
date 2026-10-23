import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Action, Item, Launcher, Section, View} from '../lib/launcher.ts';
import {notifyError, osd, SecretClipboard, Typist, type Timers} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {setPinentryBridge} from './bridge.ts';
import {ItemCache} from './cache.ts';
import {OnePasswordVault} from './onepassword.ts';
import {PinentryService, type PinRequest} from './pinentry.ts';
import {RbwVault} from './rbw.ts';
import {VaultLockedError, type ItemKind, type Prompter, type Vault, type VaultItem} from './vault.ts';

/** How to install a vault's CLI on Arch-based systems */
const INSTALL_COMMANDS: Record<string, string> = {
    bitwarden: 'sudo pacman -S rbw',
    '1password': 'pamac build 1password-cli',
};

export type VaultStatus = 'checking' | 'locked' | 'unlocking' | 'unlocked' | 'error';

/** A vault as onboarding shows it */
export interface VaultInfo {
    vault: Vault;
    logo: Gio.Icon;
    status: VaultStatus;
    error: string;
    items: number;
    /** Self-hosted server, '' for the default */
    server: string;
}

interface VaultState {
    status: VaultStatus;
    error: string;
    items: VaultItem[];
    /** Bumped on every reload, so a slow, stale response is dropped. */
    generation: number;
}

type What = 'password' | 'user' | 'totp' | 'login';

const LABELS: Record<What, string> = {
    password: 'Password',
    user: 'Username',
    totp: 'TOTP code',
    login: 'Login',
};

const KIND_ICONS: Record<ItemKind, string> = {
    login: 'dialog-password-symbolic',
    card: 'auth-smartcard-symbolic',
    identity: 'avatar-default-symbolic',
    note: 'text-x-generic-symbolic',
    ssh: 'network-server-symbolic',
    other: 'dialog-password-symbolic',
};

export const PASSWORDS_COLOR = '#3584e4';
const RECENT_PREFIX = 'password:';

function stripScheme(uri: string): string {
    return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
}

/** Every web address of a login, with https:// where it has no scheme */
function websitesOf(item: VaultItem): string[] {
    if (item.kind !== 'login' && item.kind !== 'other')
        return [];
    return item.urls
        .map(uri => /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`)
        .filter(url => /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url));
}

/** "123456" → "123 456" */
function formatCode(code: string): string {
    return /^\d{6,8}$/.test(code) ? code.replace(/^(\d{3,4})(\d{3,4})$/, '$1 $2') : code;
}

/** vault id → [item id, item name] of the item whose password unlocks it */
type Links = Record<string, [string, string]>;

function searchFields(item: VaultItem): Field[] {
    return [
        [10, item.name],
        [5, item.user],
        [2, item.urls.map(stripScheme)],
        [1, item.location],
        [1, item.vault.name],
    ];
}

/** Bitwarden and 1Password behind one search; locked vaults can be unlocked in place. */
export class Passwords {
    readonly #settings: Gio.Settings;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    readonly #vaults: Vault[];
    readonly #states = new Map<Vault, VaultState>();
    readonly #logos = new Map<Vault, Gio.Icon>();
    readonly #servers = new Map<Vault, string>();
    readonly #clipboard: SecretClipboard;
    readonly #typist: Typist;
    readonly #prompter: Prompter;
    readonly #settingsIds: number[];
    readonly #extensionDir: Gio.File;
    readonly #cache = new ItemCache();
    readonly #timers: Timers;
    #index = new SearchIndex<VaultItem>([], searchFields);
    #pinentry: PinentryService | null = null;
    #destroyed = false;

    readonly view: View;

    constructor(settings: Gio.Settings, timers: Timers, extensionDir: Gio.File, launcher: Launcher, recents: Recents) {
        this.#settings = settings;
        this.#extensionDir = extensionDir;
        const iconsDir = extensionDir.get_child('icons');
        this.#launcher = launcher;
        this.#recents = recents;
        this.#vaults = [new RbwVault(settings), new OnePasswordVault(settings)];
        for (const vault of this.#vaults) {
            this.#logos.set(vault, new Gio.FileIcon({file: iconsDir.get_child(vault.logo)}));
            this.#states.set(vault, {status: 'checking', error: '', items: vault.enabled ? this.#cache.items(vault) : [], generation: 0});
        }
        this.#timers = timers;
        this.#clipboard = new SecretClipboard(settings, timers);
        this.#typist = new Typist(settings, timers);
        this.#prompter = {
            askSecret: (prompt, description) => this.#launcher.askSecret({prompt, description}),
            askText: (prompt, description) => this.#launcher.ask({prompt, description, secret: false, action: 'Continue'}),
            stepAside: task => this.#stepAside(task),
        };

        this.view = {
            title: 'Passwords',
            icon: 'dialog-password-symbolic',
            placeholder: 'Search passwords…',
            search: query => this.#viewSections(query),
            actions: () => this.#viewActions(),
        };

        this.#settingsIds = [
            settings.connect('changed::rbw-pinentry-bridge', () => this.#updatePinentry()),
            settings.connect('changed::bitwarden-enabled', () => this.reload()),
            settings.connect('changed::onepassword-enabled', () => this.reload()),
        ];
        this.#updatePinentry();
    }

    destroy() {
        this.#destroyed = true;
        for (const id of this.#settingsIds)
            this.#settings.disconnect(id);
        this.#pinentry?.destroy();
        this.#clipboard.clearNow();
        this.#typist.destroy();
        for (const vault of this.#vaults)
            vault.destroy();
    }

    get #enabledVaults(): Vault[] {
        return this.#vaults.filter(v => v.enabled);
    }

    // --- What the launcher shows ---

    /** Best matches for the start view; nothing for an empty query. */
    search(query: string, limit: number): Item[] {
        if (!query.trim())
            return [];
        return this.#index.search(query, {all: true}).slice(0, limit).map(item => this.#item(item));
    }

    /** "Unlock Bitwarden" rows for vaults that are locked or failing. */
    vaultRows(): Item[] {
        return this.#enabledVaults
            .filter(v => ['locked', 'unlocking', 'error'].includes(this.#state(v).status))
            .map(vault => this.#vaultRow(vault));
    }

    /** Commands for the start view. */
    commands(): Item[] {
        const command = (id: string, icon: string, title: string, subtitle: string, run: () => void): Item => ({
            id: `command:${id}`,
            icon: {name: icon, color: PASSWORDS_COLOR},
            title,
            subtitle,
            accessory: 'Command',
            actions: [{title: id === 'passwords' ? 'Open' : title, icon, run}],
        });
        return [
            command('passwords', 'dialog-password-symbolic', 'Search Passwords',
                this.#enabledVaults.map(v => v.name).join(' & ') || 'No vault enabled',
                () => this.#launcher.push(this.view)),
            command('lock-vaults', 'system-lock-screen-symbolic', 'Lock Vaults', 'Passwords', () => void this.#lockAll()),
            command('sync-vaults', 'view-refresh-symbolic', 'Sync Vaults', 'Passwords', () => void this.#sync()),
        ];
    }

    /** A recently used item, if its vault is unlocked. */
    recent(id: string): Item | null {
        if (!id.startsWith(RECENT_PREFIX))
            return null;
        const itemId = id.slice(RECENT_PREFIX.length);
        const item = this.#index.items.find(i => i.id === itemId);
        return item ? this.#item(item) : null;
    }

    /** Every vault, including turned off and not installed ones. */
    vaults(): VaultInfo[] {
        return this.#vaults.map(vault => {
            const {status, error, items} = this.#state(vault);
            return {vault, logo: this.#logos.get(vault)!, status, error, items: items.length, server: this.#servers.get(vault) ?? ''};
        });
    }

    /** Turns a vault on, sets it up if needed, and unlocks it. */
    async connect(vault: Vault) {
        try {
            this.#settings.set_boolean(vault.enabledKey, true);
            if (vault.setUp && !await vault.setUp(this.#prompter))
                return;
            // Ask for rbw's master password right here instead of in a separate pinentry window.
            if (vault instanceof RbwVault && !this.#settings.get_boolean('rbw-pinentry-bridge')) {
                await setPinentryBridge(this.#settings, true, this.#extensionDir).catch(e =>
                    console.warn('quick-launcher: Could not set up the rbw pinentry bridge', e));
            }
            if (await vault.isUnlocked()) {
                await this.#reload(vault);
                return;
            }
        } catch (e) {
            this.#setState(vault, {status: 'error', error: (e as Error).message});
            return;
        }
        await this.#unlock(vault);
    }

    /** Asks for another server, then signs in there. */
    async changeServer(vault: Vault) {
        if (!vault.askServer || !vault.setServer)
            return;
        try {
            const server = await vault.askServer(this.#prompter);
            if (server === null)
                return;
            await vault.setServer(server);
        } catch (e) {
            this.#setState(vault, {status: 'error', error: (e as Error).message});
            return;
        }
        this.#cache.forget(vault);
        this.#setState(vault, {status: 'locked', items: []});
        await this.connect(vault);
    }

    setEnabled(vault: Vault, enabled: boolean) {
        this.#settings.set_boolean(vault.enabledKey, enabled);
    }

    #viewSections(query: string): Section[] {
        const items = this.#index.search(query).map(item => this.#item(item));
        const locked = this.vaultRows();
        // Locked vaults come first while browsing, but must not steal Enter from a search hit.
        return query.trim() && items.length
            ? [{items}, {title: 'Locked', items: locked}]
            : [{items: locked}, {items}];
    }

    #viewActions(): Action[] {
        return [
            {title: 'Sync Vaults', icon: 'view-refresh-symbolic', shortcut: 'sync-vaults', run: () => void this.#sync()},
            {title: 'Lock Vaults', icon: 'system-lock-screen-symbolic', shortcut: 'lock-vaults', run: () => void this.#lockAll()},
        ];
    }

    #item(item: VaultItem): Item {
        const run = (verb: 'copy' | 'type', what: What) => () => void this.#perform(item, verb, what);
        // A locked vault's item is only a cached name: Enter unlocks it, and only then is there a website to open.
        const unlocked = this.#state(item.vault).status === 'unlocked';
        const website = unlocked && this.#settings.get_boolean('browser-login') ? websitesOf(item)[0] ?? null : null;
        return {
            id: item.id,
            icon: {name: KIND_ICONS[item.kind]},
            title: item.name || '(unnamed)',
            subtitle: [item.user, item.location].filter(Boolean).join('  ·  '),
            accessory: unlocked ? undefined : 'Locked',
            source: {icon: this.#logos.get(item.vault)!, styleClass: item.vault.logoClass},
            actions: [
                // Enter opens the item's fields, like 1Password's Quick Access; a locked vault is unlocked first.
                unlocked
                    ? {title: 'Show Item', icon: 'go-next-symbolic', run: () => void this.#showItem(item)}
                    : {title: `Unlock ${item.vault.name}`, icon: 'system-lock-screen-symbolic', run: () => void this.#showItem(item)},
                ...website ? [{
                    title: 'Open and Log In', icon: 'web-browser-symbolic', shortcut: 'open-website',
                    run: () => void this.#logIn(item, website),
                } satisfies Action] : [],
                {title: 'Copy Password', icon: 'edit-copy-symbolic', shortcut: 'copy-password', run: run('copy', 'password')},
                {title: 'Copy Username', icon: 'avatar-default-symbolic', shortcut: 'copy-username', run: run('copy', 'user')},
                {title: 'Type Password', icon: 'input-keyboard-symbolic', shortcut: 'type-password', run: run('type', 'password')},
                {title: 'Type Username and Password', icon: 'input-keyboard-symbolic', shortcut: 'type-login', run: run('type', 'login')},
                {title: 'Copy TOTP Code', icon: 'preferences-system-time-symbolic', shortcut: 'copy-totp', run: run('copy', 'totp')},
                {title: 'Type Username', icon: 'input-keyboard-symbolic', shortcut: 'type-username', run: run('type', 'user')},
                {title: 'Type TOTP Code', icon: 'input-keyboard-symbolic', shortcut: 'type-totp', run: run('type', 'totp')},
                ...this.#linkActions(item),
            ],
        };
    }

    /** "Use to Unlock Bitwarden": the item's password becomes another vault's master password. */
    #linkActions(item: VaultItem): Action[] {
        const links = this.#links();
        return this.#enabledVaults
            .filter(vault => vault !== item.vault && vault.asksPassword)
            .map(vault => links[vault.id]?.[0] === item.id
                ? {title: `Stop Unlocking ${vault.name} with This`, icon: 'changes-allow-symbolic', run: () => this.#link(vault, null)}
                : {title: `Use to Unlock ${vault.name}`, icon: 'system-lock-screen-symbolic', run: () => this.#link(vault, item)});
    }

    /** The fields of an unlocked item: Enter copies one, Shift+Enter types it. */
    #itemView(item: VaultItem): View {
        let code: string | null = null;
        const view: View = {
            title: item.name || '(unnamed)',
            icon: KIND_ICONS[item.kind],
            placeholder: `Search ${item.name || 'item'}…`,
            search: query => {
                const text = query.trim().toLowerCase();
                const fields = this.#fields(item, code)
                    .filter(f => !text || `${f.subtitle} ${f.id === 'field:password' ? '' : f.title}`.toLowerCase().includes(text));
                return [{items: fields}];
            },
            actions: () => this.#viewActions(),
        };

        // The TOTP code is shown and renewed every 30 seconds while the item is open.
        const loadCode = async () => {
            try {
                code = (await item.vault.secret(item, 'totp')) || null;
            } catch {
                code = null;
            }
            if (this.#destroyed || !code || this.#launcher.view !== view)
                return;
            this.#launcher.refresh();
            this.#timers.add(30_000 - Date.now() % 30_000 + 300, () => {
                if (!this.#destroyed && this.#launcher.isOpen && this.#launcher.view === view)
                    void loadCode();
            });
        };
        if (item.kind === 'login' || item.kind === 'other')
            void loadCode();
        return view;
    }

    #fields(item: VaultItem, code: string | null): Item[] {
        const source = {icon: this.#logos.get(item.vault)!, styleClass: item.vault.logoClass};
        const field = (what: What, icon: string, title: string): Item => ({
            id: `field:${what}`,
            icon: {name: icon},
            title,
            subtitle: what === 'totp' ? 'One-time code' : LABELS[what],
            source,
            actions: [
                {title: `Copy ${LABELS[what]}`, icon: 'edit-copy-symbolic', run: () => void this.#perform(item, 'copy', what)},
                {title: `Type ${LABELS[what]}`, icon: 'input-keyboard-symbolic', shortcut: 'type-password', run: () => void this.#perform(item, 'type', what)},
            ],
        });
        const fields: Item[] = [];
        if (item.user)
            fields.push(field('user', 'avatar-default-symbolic', item.user));
        if (item.kind !== 'note' && item.kind !== 'identity')
            fields.push(field('password', 'dialog-password-symbolic', '•'.repeat(12)));
        if (code)
            fields.push(field('totp', 'preferences-system-time-symbolic', formatCode(code)));
        if (item.user && item.kind !== 'note' && item.kind !== 'identity') {
            fields.push({
                ...field('login', 'input-keyboard-symbolic', 'Username and Password'),
                subtitle: 'Tab between them',
                actions: [{title: 'Type Username and Password', icon: 'input-keyboard-symbolic', run: () => void this.#perform(item, 'type', 'login')}],
            });
        }
        const logIn = this.#settings.get_boolean('browser-login');
        for (const [i, url] of websitesOf(item).entries()) {
            fields.push({
                id: `field:url:${i}`,
                icon: {name: 'web-browser-symbolic'},
                title: stripScheme(url),
                subtitle: 'Website',
                source,
                actions: [
                    {title: logIn ? 'Open and Log In' : 'Open in Browser', icon: 'web-browser-symbolic', run: () => void this.#logIn(item, url, logIn)},
                    {title: 'Copy Address', icon: 'edit-copy-symbolic', run: () => {
                        this.#launcher.close();
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, url);
                        osd('edit-copy-symbolic', 'Address copied');
                    }},
                ],
            });
        }
        return fields;
    }

    /** Unlocks the item's vault if needed, then shows its fields. */
    async #showItem(found: VaultItem) {
        const item = await this.#unlocked(found);
        if (this.#destroyed || !this.#launcher.isOpen)
            return;
        if (!item) {
            if (this.#state(found.vault).status === 'unlocked')
                Main.notify(found.vault.name, `${found.name} is no longer in the vault`);
            return;
        }
        this.#recents.add(`${RECENT_PREFIX}${item.id}`);
        this.#launcher.push(this.#itemView(item), '', 'field:password');
    }

    // --- Unlocking a vault with another vault's item ---

    #links(): Links {
        return this.#settings.get_value('unlock-with').deepUnpack() as Links;
    }

    #link(vault: Vault, item: VaultItem | null) {
        const links = this.#links();
        if (item)
            links[vault.id] = [item.id, item.name];
        else
            delete links[vault.id];
        this.#settings.set_value('unlock-with', new GLib.Variant('a{s(ss)}', links));
        this.#launcher.close();
        osd('system-lock-screen-symbolic', item ? `${item.name} unlocks ${vault.name}` : `${vault.name} asks for its password again`);
    }

    /** `vault`'s master password from the item linked to it, unlocking that item's vault first; null to ask instead. */
    async #linkedPassword(vault: Vault): Promise<string | null> {
        const [itemId, name] = this.#links()[vault.id] ?? [];
        const source = itemId ? this.#vaults.find(v => itemId.startsWith(`${v.id}:`)) : undefined;
        // Two vaults unlocking each other would wait forever.
        if (!source || source === vault || !source.enabled || this.#state(source).status === 'unlocking')
            return null;
        try {
            const placeholder = this.#state(source).items.find(i => i.id === itemId) ?? {
                id: itemId, nativeId: itemId.slice(source.id.length + 1), vault: source,
                name, user: '', location: '', urls: [], kind: 'other',
            } satisfies VaultItem;
            const item = await this.#unlocked(placeholder);
            return item ? await source.secret(item, 'password') || null : null;
        } catch (e) {
            console.warn(`quick-launcher: Could not unlock ${vault.name} with ${name}`, e);
            return null;
        }
    }

    /** The prompter for unlocking `vault`: its first password question is answered by the linked item. */
    #prompterFor(vault: Vault): Prompter {
        let tried = false;
        return {
            ...this.#prompter,
            askSecret: async (prompt, description) => {
                if (!tried) {
                    tried = true;
                    const password = await this.#linkedPassword(vault);
                    if (password !== null)
                        return password;
                }
                return this.#prompter.askSecret(prompt, description);
            },
        };
    }

    #vaultRow(vault: Vault): Item {
        const {status, error} = this.#state(vault);
        const actions: Action[] = [
            // connect() also asks for what is missing first, such as rbw's account email.
            {title: status === 'error' ? 'Retry' : 'Unlock', icon: 'system-lock-screen-symbolic', run: () => void this.connect(vault)},
            ...vault.askServer ? [{
                title: 'Use Another Server…', icon: 'network-server-symbolic', shortcut: 'vault-server',
                run: () => void this.changeServer(vault),
            } satisfies Action] : [],
        ];
        const base = {
            id: `vault:${vault.id}`,
            source: {icon: this.#logos.get(vault)!, styleClass: vault.logoClass},
            actions,
        };
        switch (status) {
        case 'unlocking':
            return {...base, icon: {name: 'content-loading-symbolic'}, title: `Unlocking ${vault.name}…`, dim: true};
        case 'error':
            return {...base, icon: {name: 'dialog-warning-symbolic'}, ...this.#remedy(vault, error, actions[0])};
        default:
            return {...base, icon: {name: 'system-lock-screen-symbolic'}, title: `Unlock ${vault.name}`, subtitle: 'Locked'};
        }
    }

    /** Says what is wrong with a vault and how to fix it, with the fix as the first action. */
    #remedy(vault: Vault, error: string, retry: Action): Pick<Item, 'title' | 'subtitle' | 'actions'> {
        const turnOff: Action = {
            title: `Don’t Use ${vault.name}`, icon: 'process-stop-symbolic', shortcut: 'vault-off',
            run: () => this.setEnabled(vault, false),
        };
        const open = (title: string, uri: string): Action => ({title, icon: 'web-browser-symbolic', run: () => {
            this.#launcher.close();
            Gio.AppInfo.launch_default_for_uri(uri, null);
        }});
        if (!vault.installed) {
            const install = INSTALL_COMMANDS[vault.id];
            return {
                title: `${vault.name} needs ${vault.id === 'bitwarden' ? 'rbw' : 'the 1Password CLI'}`,
                subtitle: `Install it${install ? ` in a terminal: ${install}` : ''}, then press Enter to retry`,
                actions: [
                    {...retry, title: 'Retry'},
                    ...install ? [{title: 'Copy Install Command', icon: 'edit-copy-symbolic', run: () => {
                        this.#launcher.close();
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, install);
                        osd('edit-copy-symbolic', 'Install command copied');
                    }} satisfies Action] : [],
                    open('Open Install Guide', vault.website),
                    turnOff,
                ],
            };
        }
        if (vault.id === '1password' && error.startsWith('No account set up')) {
            return {
                title: 'Turn on the 1Password CLI integration',
                subtitle: '1Password → Settings → Developer → “Integrate with 1Password CLI”, then press Enter',
                actions: [
                    {...retry, title: 'Retry'},
                    {title: 'Open 1Password', icon: 'dialog-password-symbolic', run: () => {
                        this.#launcher.close();
                        try {
                            Gio.Subprocess.new(['1password'], Gio.SubprocessFlags.NONE);
                        } catch (e) {
                            notifyError('Could not open 1Password', e);
                        }
                    }},
                    open('Open Guide', 'https://developer.1password.com/docs/cli/app-integration/'),
                    turnOff,
                ],
            };
        }
        return {title: `${vault.name} is unavailable`, subtitle: `${error} · Enter retries`, actions: [retry, turnOff]};
    }

    // --- Vault state ---

    #state(vault: Vault): VaultState {
        return this.#states.get(vault)!;
    }

    #setState(vault: Vault, changes: Partial<VaultState>) {
        Object.assign(this.#state(vault), changes);
        if ('items' in changes || 'status' in changes) {
            this.#index = new SearchIndex(
                this.#enabledVaults
                    .flatMap(v => this.#state(v).items)
                    .sort((a, b) => a.name.localeCompare(b.name)),
                searchFields);
        }
        this.#launcher.refresh();
    }

    /** Checks every enabled vault in the background and loads its items. */
    reload() {
        for (const vault of this.#vaults) {
            if (vault.enabled)
                void this.#reload(vault);
            else
                this.#forget(vault);
        }
    }

    async #reload(vault: Vault) {
        const generation = ++this.#state(vault).generation;
        const current = () => !this.#destroyed && this.#state(vault).generation === generation;
        vault.server?.().then(server => {
            if (!this.#destroyed && server !== (this.#servers.get(vault) ?? '')) {
                this.#servers.set(vault, server);
                this.#launcher.refresh();
            }
        }).catch(() => {});

        try {
            if (!await vault.isUnlocked()) {
                if (current() && this.#state(vault).status !== 'unlocking')
                    this.#setState(vault, {status: 'locked', items: this.#cache.items(vault)});
                return;
            }
            const items = await vault.list();
            if (current()) {
                this.#setState(vault, {status: 'unlocked', error: '', items});
                this.#cache.set(vault, items);
            }
        } catch (e) {
            if (!current())
                return;
            if (e instanceof VaultLockedError) {
                this.#setState(vault, {status: 'locked', items: this.#cache.items(vault)});
                return;
            }
            console.error(`quick-launcher: Could not load ${vault.name}`, e);
            this.#setState(vault, {status: 'error', error: (e as Error).message, items: this.#cache.items(vault)});
        }
    }

    async #unlock(vault: Vault) {
        const state = this.#state(vault);
        if (state.status === 'unlocking')
            return;
        if (state.status === 'error') {
            await this.#reload(vault);
            if (this.#state(vault).status !== 'locked')
                return;
        }

        this.#setState(vault, {status: 'unlocking'});
        try {
            const ok = await vault.unlock(this.#prompterFor(vault));
            if (this.#destroyed)
                return;
            this.#setState(vault, {status: ok ? 'checking' : 'locked'});
            if (ok)
                await this.#reload(vault);
        } catch (e) {
            if (!this.#destroyed)
                this.#setState(vault, {status: 'error', error: (e as Error).message});
        }
    }

    /** Hides the launcher while another prompt needs the keyboard, then brings it back. */
    async #stepAside<R>(task: () => Promise<R>): Promise<R> {
        const wasOpen = this.#launcher.isOpen;
        const restore = this.#launcher.stack;
        this.#launcher.close();
        try {
            return await task();
        } finally {
            if (wasOpen && !this.#destroyed && restore.length)
                this.#launcher.open(restore[0].view, {restore});
        }
    }

    async #sync() {
        this.#launcher.setStatus('Syncing…');
        await Promise.all(this.#enabledVaults
            .filter(v => this.#state(v).status === 'unlocked')
            .map(async v => {
                try {
                    await v.sync();
                } catch (e) {
                    notifyError(`Could not sync ${v.name}`, e);
                }
            }));
        this.#launcher.setStatus(null);
        this.reload();
    }

    async #lockAll() {
        await Promise.all(this.#enabledVaults.map(v => v.lock().catch(e => notifyError(`Could not lock ${v.name}`, e))));
        for (const vault of this.#enabledVaults)
            this.#setState(vault, {status: 'locked', items: this.#cache.items(vault)});
        this.#clipboard.clear();
        osd('system-lock-screen-symbolic', 'Vaults locked');
    }

    #updatePinentry() {
        const wanted = this.#settings.get_boolean('rbw-pinentry-bridge');
        if (wanted && !this.#pinentry) {
            this.#pinentry = new PinentryService(request => this.#askPin(request));
        } else if (!wanted && this.#pinentry) {
            this.#pinentry.destroy();
            this.#pinentry = null;
        }
    }

    async #askPin({title, description, prompt, error}: PinRequest): Promise<string | null> {
        // rbw sends title "rbw" and prompt "Master Password". Only the first try is
        // answered from a linked item; after a wrong password rbw asks again with an error.
        const rbw = this.#vaults.find(v => v instanceof RbwVault);
        if (title === 'rbw' && rbw && !error && /master password/i.test(prompt)) {
            const password = await this.#linkedPassword(rbw);
            if (password !== null)
                return password;
        }
        const name = title === 'rbw' ? 'Bitwarden' : title;
        return this.#launcher.askSecret({
            prompt: [name, (prompt || 'password').toLowerCase()].filter(Boolean).join(' '),
            description: [error, description].filter(Boolean).join(' · ') || undefined,
        });
    }

    // --- Using an item ---

    /** A turned off vault forgets its cached items. */
    #forget(vault: Vault) {
        this.#cache.forget(vault);
        this.#setState(vault, {status: 'checking', items: []});
    }

    /** Unlocks the item's vault if it is locked; resolves the current item, or null if it stayed locked. */
    async #unlocked(item: VaultItem): Promise<VaultItem | null> {
        if (this.#state(item.vault).status !== 'unlocked') {
            await this.connect(item.vault);
            if (this.#destroyed || this.#state(item.vault).status !== 'unlocked')
                return null;
        }
        // Always the loaded item: a row shown while the vault was locked only has the cached name.
        return this.#state(item.vault).items.find(i => i.id === item.id) ?? null;
    }

    async #perform(found: VaultItem, verb: 'copy' | 'type', what: What, retry = true) {
        this.#recents.add(`${RECENT_PREFIX}${found.id}`);
        // Only names are cached, so everything needs the vault unlocked; that asks right in the launcher.
        const item = await this.#unlocked(found);
        if (!item) {
            if (!this.#destroyed && this.#state(found.vault).status === 'unlocked')
                Main.notify(found.vault.name, `${found.name} is no longer in the vault`);
            return;
        }
        this.#launcher.close();
        try {
            const value = await this.#valueOf(item, what);
            if (this.#destroyed)
                return;
            if (!value) {
                Main.notify(item.vault.name, `${item.name} has no ${LABELS[what].toLowerCase()}`);
                return;
            }

            if (verb === 'copy') {
                this.#clipboard.copy(value);
                osd('edit-copy-symbolic', `${LABELS[what]} copied from ${item.vault.name}`);
            } else {
                const submit = (what === 'password' || what === 'login') &&
                    this.#settings.get_boolean('submit-after-password');
                await this.#typist.type(submit ? `${value}\n` : value);
            }
        } catch (e) {
            if (e instanceof VaultLockedError) {
                // It locked itself since the last check: unlock and try once more.
                this.#setState(item.vault, {status: 'locked', items: this.#cache.items(item.vault)});
                if (retry)
                    await this.#perform(item, verb, what, false);
                return;
            }
            notifyError(`Could not get ${LABELS[what].toLowerCase()} for ${item.name}`, e);
        }
    }

    /**
     * Opens the website in the default browser (a new tab if it is running), then
     * presses the browser extension's autofill shortcut, once the browser has focus.
     */
    async #logIn(item: VaultItem, website: string, autofill = true) {
        this.#recents.add(`${RECENT_PREFIX}${item.id}`);
        this.#launcher.close();
        const browser = Gio.AppInfo.get_default_for_uri_scheme('https');
        try {
            const context = global.create_app_launch_context(0, -1);
            if (browser)
                browser.launch_uris([website], context);
            else
                Gio.AppInfo.launch_default_for_uri(website, context);
        } catch (e) {
            notifyError(`Could not open ${website}`, e);
            return;
        }

        const keys = !autofill ? '' : this.#settings.get_string(`${item.vault.id === 'bitwarden' ? 'bitwarden' : 'onepassword'}-autofill-keys`).trim();
        if (!keys)
            return;
        await this.#timers.sleep(this.#settings.get_int('autofill-delay-ms'));
        if (this.#destroyed)
            return;
        // Only press keys into the browser, never into whatever got focus instead.
        const window = global.display.focus_window;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        if (!app || (browser && app.get_id() !== browser.get_id())) {
            Main.notify(item.vault.name, `Opened ${item.name}, but the browser wasn’t focused to fill the login`);
            return;
        }
        try {
            await this.#typist.press(keys);
        } catch (e) {
            notifyError('Could not fill the login', e);
        }
    }

    async #valueOf(item: VaultItem, what: What): Promise<string> {
        switch (what) {
        case 'user':
            return item.user;
        case 'password':
        case 'totp':
            return item.vault.secret(item, what);
        case 'login': {
            const password = await item.vault.secret(item, 'password');
            return item.user ? `${item.user}\t${password}` : password;
        }
        }
    }
}
