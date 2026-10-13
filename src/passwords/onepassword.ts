import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CommandError, findProgram, run, type RunOptions} from '../lib/subprocess.ts';
import {VaultLockedError, type ItemKind, type Prompter, type SecretField, type Vault, type VaultItem} from './vault.ts';

const KINDS: Record<string, ItemKind> = {
    LOGIN: 'login',
    PASSWORD: 'login',
    API_CREDENTIAL: 'login',
    DATABASE: 'login',
    SERVER: 'login',
    CREDIT_CARD: 'card',
    IDENTITY: 'identity',
    SECURE_NOTE: 'note',
    SSH_KEY: 'ssh',
};

/** `op` messages that mean "sign in first" rather than a real failure. */
const SIGNED_OUT = /not (currently )?signed in|session expired|sign ?in|authoriz|locked|unauthenticated/i;

const MAX_ATTEMPTS = 3;

/** The useful part of op's stderr: "[ERROR] 2026/10/12 14:47:50 message" → "message" */
function opError(stderr: string, fallback: string): CommandError {
    const message = stderr.trim().split('\n')[0]?.replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, '').trim() || fallback;
    if (/no account(s)? (found|configured)/i.test(message))
        return new CommandError('No account set up: turn on CLI integration in the 1Password app, or run op account add', stderr);
    return new CommandError(message, stderr);
}

interface OpListItem {
    id: string;
    title?: string;
    category?: string;
    vault?: {id: string; name?: string};
    urls?: {href: string; primary?: boolean}[];
    additional_information?: string;
}

interface OpField {
    id?: string;
    type?: string;
    purpose?: string;
    value?: string;
    totp?: string;
}

/** 1Password through the `op` CLI, unlocked by the desktop app or a master password. */
export class OnePasswordVault implements Vault {
    readonly id = '1password';
    readonly name = '1Password';
    readonly logo = '1password.svg';
    readonly logoClass = 'ql-source-1password';
    readonly color = '#0b6bcb';
    readonly website = 'https://developer.1password.com/docs/cli/get-started/';
    readonly enabledKey = 'onepassword-enabled';
    readonly #settings: Gio.Settings;
    /** Session token from `op signin --raw`; only lives in memory. */
    #session: string | null = null;
    readonly #vaultOf = new Map<string, string>();

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get enabled(): boolean {
        return this.#settings.get_boolean(this.enabledKey);
    }

    get installed(): boolean {
        return findProgram(this.#settings.get_string('op-path') || 'op') !== null;
    }

    get #usesApp(): boolean {
        const method = this.#settings.get_string('onepassword-unlock');
        if (method !== 'auto')
            return method === 'app';
        return GLib.file_test('/opt/1Password/1password', GLib.FileTest.EXISTS) ||
            GLib.find_program_in_path('1password') !== null;
    }

    #run(args: string[], options?: RunOptions) {
        const account = this.#settings.get_string('onepassword-account');
        return run([
            this.#settings.get_string('op-path') || 'op',
            ...account ? ['--account', account] : [],
            ...this.#session ? ['--session', this.#session] : [],
            ...args,
        ], options);
    }

    /** Runs an op command that needs a session, mapping sign-in errors. */
    async #runSignedIn(args: string[]) {
        const result = await this.#run(args, {check: false});
        if (result.ok)
            return result;
        if (SIGNED_OUT.test(result.stderr)) {
            this.#session = null;
            throw new VaultLockedError(this);
        }
        throw opError(result.stderr, `op ${args.slice(0, 2).join(' ')} failed`);
    }

    async isUnlocked(): Promise<boolean> {
        const {ok, stderr} = await this.#run(['whoami'], {check: false});
        if (!ok && !SIGNED_OUT.test(stderr))
            throw opError(stderr, 'op whoami failed');
        if (!ok)
            this.#session = null;
        return ok;
    }

    async unlock(prompter: Prompter): Promise<boolean> {
        if (this.#usesApp) {
            // The app shows its own prompt (or system authentication).
            const {ok, stderr} = await prompter.stepAside(() => this.#run(['signin'], {check: false}));
            if (!ok && !/dismiss|cancel/i.test(stderr))
                throw opError(stderr, 'op signin failed');
            return ok;
        }

        let error = '';
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const account = this.#settings.get_string('onepassword-account');
            const password = await prompter.askSecret('1Password master password',
                error || (account ? `Account ${account}` : undefined));
            if (password === null)
                return false;

            this.#session = null;
            const {ok, stdout, stderr} = await this.#run(['signin', '--raw'],
                {stdin: `${password}\n`, check: false});
            if (ok && stdout.trim()) {
                this.#session = stdout.trim();
                return true;
            }
            error = opError(stderr, 'Sign-in failed').message;
        }
        return false;
    }

    async lock() {
        await this.#run(['signout'], {check: false});
        this.#session = null;
    }

    async sync() {}

    async list(): Promise<VaultItem[]> {
        const {stdout} = await this.#runSignedIn(['item', 'list', '--format', 'json']);
        const items = JSON.parse(stdout || '[]') as OpListItem[];
        this.#vaultOf.clear();
        return items.map(e => {
            if (e.vault)
                this.#vaultOf.set(e.id, e.vault.id);
            const kind = KINDS[e.category ?? ''] ?? 'other';
            return {
                id: `${this.id}:${e.id}`,
                nativeId: e.id,
                vault: this,
                name: e.title ?? '',
                // For logins this is the username; for cards etc. it's a masked summary.
                user: kind === 'login' ? e.additional_information ?? '' : '',
                location: e.vault?.name ?? '',
                urls: (e.urls ?? []).map(u => u.href),
                kind,
            };
        });
    }

    async secret(item: VaultItem, field: SecretField): Promise<string> {
        const vault = this.#vaultOf.get(item.nativeId);
        const target = ['item', 'get', item.nativeId, ...vault ? ['--vault', vault] : []];

        if (field === 'totp')
            return (await this.#runSignedIn([...target, '--otp'])).stdout.trim();

        const {stdout} = await this.#runSignedIn([...target, '--format', 'json', '--reveal']);
        const fields = (JSON.parse(stdout) as {fields?: OpField[]}).fields ?? [];
        const password = fields.find(f => f.purpose === 'PASSWORD') ??
            fields.find(f => f.id === 'password' || f.id === 'credential') ??
            fields.find(f => f.type === 'CONCEALED' && f.value);
        return password?.value ?? '';
    }

    destroy() {
        this.#session = null;
    }
}
