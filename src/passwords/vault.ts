export type ItemKind = 'login' | 'card' | 'identity' | 'note' | 'ssh' | 'other';

export type SecretField = 'password' | 'totp';

export interface VaultItem {
    /** Unique across vaults: `${vault.id}:${nativeId}` */
    id: string;
    nativeId: string;
    vault: Vault;
    name: string;
    user: string;
    /** Folder (Bitwarden) or vault name (1Password) */
    location: string;
    urls: string[];
    kind: ItemKind;
}

/** Lets a vault ask for a master password without knowing about the UI. */
export interface Prompter {
    /** Asks inside the launcher; resolves null if cancelled. */
    askSecret(prompt: string, description?: string): Promise<string | null>;
    /** Like askSecret, but the answer is visible, e.g. an email address. */
    askText(prompt: string, description?: string): Promise<string | null>;
    /** Hides the launcher while an external prompt (pinentry, 1Password app) is shown. */
    stepAside<R>(task: () => Promise<R>): Promise<R>;
}

export interface Vault {
    readonly id: string;
    readonly name: string;
    /** Logo file in icons/ and the style class of its tile */
    readonly logo: string;
    readonly logoClass: string;
    /** Brand color, for the logo tile in onboarding */
    readonly color: string;
    /** Where to get the CLI it needs */
    readonly website: string;
    /** Settings key that turns it on */
    readonly enabledKey: string;
    readonly enabled: boolean;
    /** The CLI it needs is installed. */
    readonly installed: boolean;

    /** One-time setup before the first unlock, e.g. the account email. Resolves false if cancelled. */
    setUp?(prompter: Prompter): Promise<boolean>;
    /** Asks for a self-hosted server URL; resolves '' for the default server and null if cancelled. */
    askServer?(prompter: Prompter): Promise<string | null>;
    /** The configured self-hosted server, '' for the default */
    server?(): Promise<string>;
    setServer?(server: string): Promise<void>;

    isUnlocked(): Promise<boolean>;
    /** Resolves false if the user cancelled. */
    unlock(prompter: Prompter): Promise<boolean>;
    lock(): Promise<void>;
    /** Item metadata only; secrets are fetched on demand. */
    list(): Promise<VaultItem[]>;
    sync(): Promise<void>;
    secret(item: VaultItem, field: SecretField): Promise<string>;
    destroy(): void;
}

/** Thrown when an operation failed because the vault is (again) locked. */
export class VaultLockedError extends Error {
    constructor(vault: Vault) {
        super(`${vault.name} is locked`);
        this.name = 'VaultLockedError';
    }
}
