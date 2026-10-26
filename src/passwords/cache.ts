import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Vault, VaultItem} from './vault.ts';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

/** Only what finds an item again; usernames, URLs and folders stay in the vault. */
type CachedItem = Pick<VaultItem, 'nativeId' | 'name'>;

function trim({nativeId, name}: CachedItem): CachedItem {
    return {nativeId, name};
}

/**
 * The item names of each vault on disk, so items can be found while their
 * vault is locked. Using one unlocks the vault first.
 */
export class ItemCache {
    readonly #file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'passwords.json']));

    #data: Record<string, CachedItem[]>;

    constructor() {
        try {
            const [, bytes] = this.#file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, CachedItem[]>;
            this.#data = Object.fromEntries(Object.entries(data).map(([vault, items]) => [vault, items.map(trim)]));
            // Older versions also kept usernames, URLs and folders: drop them from the disk too.
            if (JSON.stringify(this.#data) !== JSON.stringify(data))
                void this.#save();
        } catch {
            this.#data = {};
        }
    }

    /** Placeholders for a locked vault's items, with nothing but their names */
    items(vault: Vault): VaultItem[] {
        return (this.#data[vault.id] ?? []).map(({nativeId, name}) => ({
            id: `${vault.id}:${nativeId}`, nativeId, vault, name, user: '', location: '', urls: [], kind: 'other',
        }));
    }

    set(vault: Vault, items: VaultItem[]) {
        this.#data[vault.id] = items.map(trim);
        void this.#save();
    }

    forget(vault: Vault) {
        if (!(vault.id in this.#data))
            return;
        delete this.#data[vault.id];
        void this.#save();
    }

    async #save() {
        try {
            this.#file.get_parent()!.make_directory_with_parents(null);
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))) {
                console.error('quick-launcher: Could not create the cache directory', e);
                return;
            }
        }
        try {
            await this.#file.replace_contents_async(new TextEncoder().encode(JSON.stringify(this.#data)),
                null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error('quick-launcher: Could not write the password cache', e);
        }
    }
}
