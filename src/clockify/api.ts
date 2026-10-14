import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type {Project, Tag, TimeEntry} from './tasks.ts';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export class ClockifyError extends Error {
    readonly status: number;

    constructor(message: string, status = 0) {
        super(message);
        this.name = 'ClockifyError';
        this.status = status;
    }
}

/** HTTP 429: the Free plan allows only 30 workspace requests per hour. */
export class RateLimitError extends ClockifyError {
    constructor() {
        super('Clockify request limit reached (Free plan: 30 per hour), showing the last known state', 429);
        this.name = 'RateLimitError';
    }
}

interface Me {
    id: string;
    workspace: string;
}

export interface NewEntry {
    description: string;
    projectId?: string;
    taskId?: string;
    tagIds: string[];
    billable: boolean;
}

/**
 * When the last workspace requests were sent; those count towards Clockify's limit, /user doesn't.
 * Module-level, so it survives the extension being disabled and enabled again on screen lock.
 */
const sent: number[] = [];

function now(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export class ClockifyApi {
    readonly #settings: Gio.Settings;
    readonly #session = new Soup.Session({timeout: 20});
    readonly #cancellable = new Gio.Cancellable();
    #me: Promise<Me> | null = null;
    #meFor = '';

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get configured(): boolean {
        return this.#settings.get_string('clockify-api-key') !== '';
    }

    get #credentials(): string {
        return `${this.#settings.get_string('clockify-api-url')}|${this.#settings.get_string('clockify-api-key')}`;
    }

    /** Workspace requests sent within the last hour */
    get sentLastHour(): number {
        const hourAgo = Date.now() - 3_600_000;
        while (sent.length && sent[0] < hourAgo)
            sent.shift();
        return sent.length;
    }

    /** Identifies the account, so a cache never shows another account's data. */
    get account(): string {
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, this.#credentials, -1) ?? '';
    }

    async #request<T>(method: string, path: string, {query = {}, body, key}: {
        query?: Record<string, string | number | boolean>;
        body?: unknown;
        /** Another API key than the saved one */
        key?: string;
    } = {}): Promise<T> {
        const base = this.#settings.get_string('clockify-api-url').replace(/\/+$/, '');
        const params = Object.entries(query)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const message = Soup.Message.new(method, `${base}${path}${params ? `?${params}` : ''}`);
        if (!message)
            throw new ClockifyError(`Invalid API URL: ${base}`);
        if (path.startsWith('/workspaces/'))
            sent.push(Date.now());

        message.request_headers.append('X-Api-Key', key ?? this.#settings.get_string('clockify-api-key'));
        if (body !== undefined) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }

        const bytes = await this.#session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this.#cancellable);
        const text = new TextDecoder().decode(bytes.toArray());
        // get_status() throws for codes missing from Soup.Status, like 429.
        const status = message.status_code;
        if (status === 429)
            throw new RateLimitError();
        if (status < 200 || status >= 300) {
            // Clockify answers with JSON {message}; proxies and wrong URLs with HTML.
            let detail = message.get_reason_phrase() ?? '';
            try {
                detail = JSON.parse(text).message || detail;
            } catch {}
            throw new ClockifyError(`${status} ${detail}`.trim(), status);
        }
        return (text ? JSON.parse(text) : null) as T;
    }

    /** Checks an API key before it is saved; resolves the account's name. */
    async verify(key: string): Promise<string> {
        const user = await this.#request<{name?: string; email?: string}>('GET', '/user', {key});
        return user.name || user.email || 'Clockify';
    }

    #user(): Promise<Me> {
        const key = this.#credentials;
        if (this.#meFor !== key || !this.#me) {
            this.#meFor = key;
            this.#me = this.#request<{id: string; activeWorkspace?: string; defaultWorkspace?: string}>('GET', '/user')
                .then(user => ({id: user.id, workspace: user.activeWorkspace || user.defaultWorkspace || ''}));
            this.#me.catch(() => {
                if (this.#meFor === key)
                    this.#me = null;
            });
        }
        return this.#me;
    }

    async #entriesPath(): Promise<string> {
        const {id, workspace} = await this.#user();
        return `/workspaces/${workspace}/user/${id}/time-entries`;
    }

    async recent(): Promise<TimeEntry[]> {
        return this.#request('GET', await this.#entriesPath(), {query: {'hydrated': true, 'page-size': 200}});
    }

    /** The running time entry, or null */
    async running(): Promise<TimeEntry | null> {
        const entries = await this.#request<TimeEntry[]>('GET', await this.#entriesPath(),
            {query: {'in-progress': true, 'hydrated': true}});
        return entries?.[0] ?? null;
    }

    async projects(): Promise<Project[]> {
        const {workspace} = await this.#user();
        return this.#request('GET', `/workspaces/${workspace}/projects`, {query: {'archived': false, 'page-size': 500}});
    }

    async tags(): Promise<Tag[]> {
        const {workspace} = await this.#user();
        return this.#request('GET', `/workspaces/${workspace}/tags`, {query: {'archived': false, 'page-size': 500}});
    }

    /** Stops the running timer at `end`. Resolves false if none was running. */
    async stop(end = now()): Promise<boolean> {
        // One request instead of asking first: Clockify answers 404 when no timer runs.
        try {
            await this.#request('PATCH', await this.#entriesPath(), {body: {end}});
            return true;
        } catch (e) {
            if (e instanceof ClockifyError && (e.status === 404 || e.status === 400))
                return false;
            throw e;
        }
    }

    /** Starts a timer, stopping the running one at the same instant so there's no gap. */
    async start({description, projectId, taskId, tagIds, billable}: NewEntry) {
        const {workspace} = await this.#user();
        const start = now();
        await this.stop(start);
        await this.#request('POST', `/workspaces/${workspace}/time-entries`, {
            body: {start, description, projectId, taskId, tagIds, billable},
        });
    }

    destroy() {
        this.#cancellable.cancel();
        this.#session.abort();
    }
}
