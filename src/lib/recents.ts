import type Gio from 'gi://Gio';

/** Enough to put often searched items first while typing; the empty start view shows fewer */
const MAX = 30;

/** Ids of recently used items, newest first, kept in settings. */
export class Recents {
    readonly #settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get ids(): string[] {
        return this.#settings.get_strv('recent');
    }

    add(id: string) {
        this.#settings.set_strv('recent', [id, ...this.ids.filter(i => i !== id)].slice(0, MAX));
    }

    remove(id: string) {
        this.#settings.set_strv('recent', this.ids.filter(i => i !== id));
    }
}
