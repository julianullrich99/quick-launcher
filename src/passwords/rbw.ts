import type Gio from 'gi://Gio';

import {CommandError, findProgram, run, type RunOptions} from '../lib/subprocess.ts';
import {normalizeServer} from './server.ts';
import {VaultLockedError, type ItemKind, type Prompter, type SecretField, type Vault, type VaultItem} from './vault.ts';

const KINDS: Record<string, ItemKind> = {
    Login: 'login',
    Card: 'card',
    Identity: 'identity',
    Note: 'note',
    SshKey: 'ssh',
};

interface RbwEntry {
    id: string;
    name?: string | null;
    user?: string | null;
    folder?: string | null;
    uris?: string[] | null;
    type?: string | null;
}

export interface RbwConfig {
    email: string;
    /** Empty for bitwarden.com */
    server: string;
}

function rbwRun(settings: Gio.Settings, args: string[], options?: RunOptions) {
    return run([settings.get_string('rbw-path') || 'rbw', ...args], options);
}

/** rbw's account email and server, from `rbw config show`. */
export async function rbwConfig(settings: Gio.Settings): Promise<RbwConfig> {
    const {stdout} = await rbwRun(settings, ['config', 'show'], {check: false});
    try {
        const config = JSON.parse(stdout) as {email?: string | null; base_url?: string | null};
        return {email: config.email ?? '', server: config.base_url ?? ''};
    } catch {
        return {email: '', server: ''};
    }
}

/**
 * Points rbw at another account or server. The agent is stopped, so the
 * next unlock logs in again instead of using the old account's keys.
 */
export async function setRbwConfig(settings: Gio.Settings, changes: Partial<RbwConfig>) {
    const current = await rbwConfig(settings);
    const email = changes.email?.trim() ?? current.email;
    const server = changes.server !== undefined ? normalizeServer(changes.server) : current.server;
    if (email === current.email && server === current.server)
        return;
    if (email !== current.email)
        await rbwRun(settings, ['config', 'set', 'email', email]);
    if (server !== current.server) {
        await rbwRun(settings, server ? ['config', 'set', 'base_url', server] : ['config', 'unset', 'base_url']);
        // Self-hosted servers serve the identity API under the same URL.
        await rbwRun(settings, ['config', 'unset', 'identity_url'], {check: false});
    }
    await rbwRun(settings, ['stop-agent'], {check: false});
}

/** Bitwarden through rbw, whose agent keeps the vault decrypted and answers instantly. */
export class RbwVault implements Vault {
    readonly id = 'bitwarden';
    readonly name = 'Bitwarden';
    readonly logo = 'bitwarden.svg';
    readonly logoClass = 'ql-source-bitwarden';
    readonly color = '#175ddc';
    readonly website = 'https://github.com/doy/rbw#installation';
    readonly enabledKey = 'bitwarden-enabled';
    readonly #settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get enabled(): boolean {
        return this.#settings.get_boolean(this.enabledKey);
    }

    get installed(): boolean {
        return findProgram(this.#settings.get_string('rbw-path') || 'rbw') !== null;
    }

    /** rbw needs the account's email, and its server unless that is bitwarden.com, before it can log in. */
    async setUp(prompter: Prompter): Promise<boolean> {
        if ((await rbwConfig(this.#settings)).email)
            return true;
        const email = (await prompter.askText('Bitwarden email', 'The email of your Bitwarden account'))?.trim();
        if (!email)
            return false;
        const server = await this.askServer(prompter);
        if (server === null)
            return false;
        await setRbwConfig(this.#settings, {email, server});
        return true;
    }

    /** Asks for the server URL; resolves '' for bitwarden.com and null if cancelled. */
    async askServer(prompter: Prompter): Promise<string | null> {
        const answer = await prompter.askText('Bitwarden server (empty for bitwarden.com)',
            'Self-hosted or EU: the URL of your vault, e.g. vault.example.com or vault.bitwarden.eu');
        return answer === null ? null : normalizeServer(answer);
    }

    async server(): Promise<string> {
        return (await rbwConfig(this.#settings)).server;
    }

    async setServer(server: string) {
        await setRbwConfig(this.#settings, {server});
    }

    #run(args: string[], options?: RunOptions) {
        return run([this.#settings.get_string('rbw-path') || 'rbw', ...args], options);
    }

    async isUnlocked(): Promise<boolean> {
        const {ok} = await this.#run(['unlocked'], {check: false});
        return ok;
    }

    async unlock(prompter: Prompter): Promise<boolean> {
        // With the pinentry bridge, rbw's password prompt is answered by
        // our launcher over D-Bus, so it can stay open. Otherwise the
        // configured pinentry needs the keyboard.
        const unlock = () => this.#run(['unlock'], {check: false});
        const {ok, stderr} = this.#settings.get_boolean('rbw-pinentry-bridge')
            ? await unlock()
            : await prompter.stepAside(unlock);

        if (!ok && !/cancel/i.test(stderr))
            throw new CommandError(stderr.trim().split('\n').at(-1) || 'rbw unlock failed', stderr);
        return ok;
    }

    async lock() {
        await this.#run(['lock'], {check: false});
    }

    async sync() {
        await this.#run(['sync']);
    }

    async list(): Promise<VaultItem[]> {
        const {stdout} = await this.#run(['list', '--raw']);
        return (JSON.parse(stdout) as RbwEntry[]).map(e => ({
            id: `${this.id}:${e.id}`,
            nativeId: e.id,
            vault: this,
            name: e.name ?? '',
            user: e.user ?? '',
            location: e.folder ?? '',
            urls: e.uris ?? [],
            kind: KINDS[e.type ?? 'Login'] ?? 'other',
        }));
    }

    async secret(item: VaultItem, field: SecretField): Promise<string> {
        if (!await this.isUnlocked())
            throw new VaultLockedError(this);

        if (field === 'totp')
            return (await this.#run(['code', item.nativeId])).stdout.trim();

        const {stdout} = await this.#run(['get', item.nativeId]);
        return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    }

    destroy() {}
}
