import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Vault, VaultItem} from './vault.ts';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

type CachedItem = Omit<VaultItem, 'vault'>;

/**
 * The item list of each vault on disk, without any secrets, so items can be
 * found while their vault is locked. Using one unlocks the vault first.
 */
export class ItemCache {
    readonly #file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'passwords.json']));

    #data: Record<string, CachedItem[]>;

    constructor() {
        try {
            const [, bytes] = this.#file.load_contents(null);
            this.#data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, CachedItem[]>;
        } catch {
            this.#data = {};
        }
    }

    items(vault: Vault): VaultItem[] {
        return (this.#data[vault.id] ?? []).map(item => ({...item, vault}));
    }

    set(vault: Vault, items: VaultItem[]) {
        this.#data[vault.id] = items.map(({vault: _, ...item}) => item);
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
