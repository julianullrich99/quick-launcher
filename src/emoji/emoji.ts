import type Gio from 'gi://Gio';
import St from 'gi://St';

import type {Item, Launcher, View} from '../lib/launcher.ts';
import {osd} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex} from '../lib/search.ts';

export const EMOJI_COLOR = '#e5a50a';
const RECENT_PREFIX = 'emoji:';

/** [emoji, English name, German name, keywords] from emojibase (MIT). */
type Entry = [string, string, string, string];

/** Searches emoji by English and German names and keywords; Enter copies. */
export class Emoji {
    readonly #dataFile: Gio.File;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    #index: SearchIndex<Entry> | null = null;

    readonly view: View;

    constructor(dataFile: Gio.File, launcher: Launcher, recents: Recents) {
        this.#dataFile = dataFile;
        this.#launcher = launcher;
        this.#recents = recents;
        this.view = {
            title: 'Emoji & Symbols',
            icon: 'face-smile-symbolic',
            placeholder: 'Search emoji…',
            search: query => [{items: this.search(query, 200)}],
        };
    }

    /** Loaded on first use; the data is ~200 KB. */
    get #entries(): SearchIndex<Entry> {
        if (!this.#index) {
            let entries: Entry[] = [];
            try {
                const [, bytes] = this.#dataFile.load_contents(null);
                entries = JSON.parse(new TextDecoder().decode(bytes));
            } catch (e) {
                console.error('quick-launcher: Could not load emoji data', e);
            }
            this.#index = new SearchIndex(entries, ([, en, de, keywords]) => [[10, en], [10, de], [3, keywords.split(' ')]]);
        }
        return this.#index;
    }

    search(query: string, limit: number): Item[] {
        return this.#entries.search(query).slice(0, limit).map(entry => this.#item(entry));
    }

    command(): Item {
        return {
            id: 'command:emoji',
            icon: {name: 'face-smile-symbolic', color: EMOJI_COLOR},
            title: 'Search Emoji & Symbols',
            subtitle: 'Emoji',
            accessory: 'Command',
            actions: [{title: 'Open', icon: 'go-next-symbolic', run: () => this.#launcher.push(this.view)}],
        };
    }

    recent(id: string): Item | null {
        if (!id.startsWith(RECENT_PREFIX))
            return null;
        const emoji = id.slice(RECENT_PREFIX.length);
        const entry = this.#entries.items.find(e => e[0] === emoji);
        return entry ? this.#item(entry) : null;
    }

    #item([emoji, en, de]: Entry): Item {
        return {
            id: `${RECENT_PREFIX}${emoji}`,
            icon: {text: emoji},
            title: en,
            subtitle: de !== en ? de : undefined,
            actions: [{
                title: 'Copy Emoji',
                icon: 'edit-copy-symbolic',
                run: () => {
                    this.#recents.add(`${RECENT_PREFIX}${emoji}`);
                    this.#launcher.close();
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, emoji);
                    osd('edit-copy-symbolic', `${emoji} copied`);
                },
            }],
        };
    }
}
