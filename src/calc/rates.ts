import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
/** The ECB publishes once per working day around 16:00 CET. */
const MAX_AGE = 12 * 3600 * 1000;

interface Cached {
    fetched: number;
    rates: Record<string, number>;
}

/** ECB euro reference rates, cached on disk and refreshed at most twice a day. */
export class ExchangeRates {
    readonly #file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'rates.json']));
    readonly #session = new Soup.Session({timeout: 10});
    readonly #cancellable = new Gio.Cancellable();
    #cached: Cached | null = null;
    #loading: Promise<void> | null = null;

    constructor() {
        try {
            const [, bytes] = this.#file.load_contents(null);
            this.#cached = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
    }

    /** Rates per 1 EUR, or undefined until they were fetched once. */
    get rates(): Record<string, number> | undefined {
        return this.#cached?.rates;
    }

    /** Fetches new rates if the cached ones are old; calls `onUpdate` when they arrive. */
    refresh(onUpdate: () => void) {
        if (this.#loading || (this.#cached && Date.now() - this.#cached.fetched < MAX_AGE))
            return;
        this.#loading = this.#fetch()
            .then(onUpdate)
            .catch(e => {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    console.warn('quick-launcher: Could not fetch exchange rates', e);
            })
            .finally(() => {
                this.#loading = null;
            });
    }

    async #fetch() {
        const message = Soup.Message.new('GET', URL)!;
        const bytes = await this.#session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this.#cancellable);
        if (message.get_status() !== 200)
            throw new Error(`HTTP ${message.get_status()}`);

        const xml = new TextDecoder().decode(bytes.toArray());
        const rates: Record<string, number> = {};
        for (const [, code, rate] of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g))
            rates[code] = Number(rate);
        if (Object.keys(rates).length === 0)
            throw new Error('No rates in the ECB response');

        this.#cached = {fetched: Date.now(), rates};
        try {
            this.#file.get_parent()!.make_directory_with_parents(null);
        } catch {}
        await this.#file.replace_contents_async(new TextEncoder().encode(JSON.stringify(this.#cached)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    destroy() {
        this.#cancellable.cancel();
        this.#session.abort();
    }
}
