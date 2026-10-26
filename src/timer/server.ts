import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Backend} from './backend.ts';
import {Http, HttpError} from './http.ts';
import {serverTasks, type Project, type Tag, type Task, type ServerEntry} from './tasks.ts';

/**
 * A time tracking server of your own, with a small REST API under one base URL
 * and a bearer token. The routes are described in the README.
 */
export class ServerApi implements Backend {
    readonly id = 'custom';
    readonly color = '#26a269';
    readonly keysUrl = null;
    readonly keyName = 'token';
    readonly #settings: Gio.Settings;
    readonly #http = new Http();
    /** The ETag of the running timer as of the last fetch */
    #etag: string | null = null;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get name(): string {
        return this.#settings.get_string('custom-tracker-name').trim() || 'Time Tracking';
    }

    get keyHint(): string {
        return `The API token of your account on ${this.#base.replace(/^[a-z]+:\/\//i, '').replace(/\/.*/, '')}`;
    }

    get #base(): string {
        return this.#settings.get_string('custom-tracker-url').trim().replace(/\/+$/, '');
    }

    get configured(): boolean {
        return this.#base !== '' && this.#settings.get_string('custom-tracker-token') !== '';
    }

    get missing() {
        return this.#base ? null : {
            setting: 'custom-tracker-url',
            prompt: 'Server URL',
            description: 'The base URL of its time tracking API, e.g. https://example.com/api/time',
        };
    }

    get account(): string {
        const credentials = `${this.#base}|${this.#settings.get_string('custom-tracker-token')}`;
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, credentials, -1) ?? '';
    }

    #request<T>(method: string, path: string, {body, key, etag}: {
        body?: unknown;
        /** Another token than the saved one */
        key?: string;
        /** Answers 304 without a body while this is still current */
        etag?: string | null;
    } = {}) {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${key ?? this.#settings.get_string('custom-tracker-token')}`,
        };
        if (etag)
            headers['If-None-Match'] = etag;
        return this.#http.request<T>(method, `${this.#base}${path}`, {headers, body});
    }

    async verify(key: string): Promise<string> {
        const {data} = await this.#request<{name?: string; email?: string}>('GET', '/me', {key});
        return data?.name || data?.email || this.name;
    }

    saveKey(key: string) {
        this.#settings.set_string('custom-tracker-token', key);
    }

    resetKey() {
        this.#settings.reset('custom-tracker-token');
    }

    async fetch(): Promise<{tasks: Task[]; projects: Project[]; tags: Tag[]}> {
        const [timer, recent, allProjects, categories] = await Promise.all([
            this.#request<ServerEntry>('GET', '/timer'),
            this.#request<ServerEntry[]>('GET', '/entries/recent?limit=100'),
            this.#request<{id: string; name: string; client?: string | null}[]>('GET', '/projects'),
            this.#request<{id: string; name: string; archivedAt?: string | null}[]>('GET', '/categories'),
        ]);
        this.#etag = timer.etag;
        // Only what parseDraft() needs, to keep the cache small.
        const projects = (allProjects.data ?? []).map(({id, name, client}) => ({id, name, clientName: client ?? ''}));
        const tags = (categories.data ?? []).filter(c => !c.archivedAt).map(({id, name}) => ({id, name}));
        return {tasks: serverTasks(recent.data ?? [], timer.data), projects, tags};
    }

    async runningChanged(): Promise<boolean> {
        const {status, etag} = await this.#request('GET', '/timer', {etag: this.#etag});
        // Without an ETag it can't tell, so it says changed.
        return status !== 304 && (etag === null || etag !== this.#etag);
    }

    async start({description, projectId, taskId, tagIds}: Task) {
        await this.#request('POST', '/timer', {body: {description, projectId, taskId, categoryId: tagIds[0]}});
    }

    async stop(): Promise<boolean> {
        try {
            await this.#request('DELETE', '/timer');
            return true;
        } catch (e) {
            if (e instanceof HttpError && e.status === 404)
                return false;
            throw e;
        }
    }

    destroy() {
        this.#http.destroy();
    }
}
