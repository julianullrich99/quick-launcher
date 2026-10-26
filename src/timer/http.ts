import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export class HttpError extends Error {
    readonly status: number;

    constructor(message: string, status = 0) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

export interface Response<T> {
    status: number;
    /** The parsed JSON body; null for an empty one, like a 304 */
    data: T | null;
    etag: string | null;
}

/** JSON requests for the time tracking backends; errors are thrown as HttpError. */
export class Http {
    readonly #session = new Soup.Session({timeout: 20});
    readonly #cancellable = new Gio.Cancellable();

    async request<T>(method: string, url: string, {headers = {}, body}: {
        headers?: Record<string, string>;
        body?: unknown;
    } = {}): Promise<Response<T>> {
        const message = Soup.Message.new(method, url);
        if (!message)
            throw new HttpError(`Invalid API URL: ${url}`);

        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        if (body !== undefined) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }

        const bytes = await this.#session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this.#cancellable);
        const text = new TextDecoder().decode(bytes.toArray());
        // get_status() throws on codes Soup.Status lacks, like 429.
        const status = message.status_code;
        if (status === 304)
            return {status, data: null, etag: message.response_headers.get_one('ETag')};
        if (status < 200 || status >= 300) {
            // APIs answer with JSON {message}; proxies and wrong URLs with HTML.
            let detail = message.get_reason_phrase() ?? '';
            try {
                const json = JSON.parse(text);
                detail = json.customMessage || json.message || json.error || detail;
            } catch {}
            throw new HttpError(`${status} ${detail}`.trim(), status);
        }
        return {
            status,
            data: (text ? JSON.parse(text) : null) as T | null,
            etag: message.response_headers.get_one('ETag'),
        };
    }

    destroy() {
        this.#cancellable.cancel();
        this.#session.abort();
    }
}
