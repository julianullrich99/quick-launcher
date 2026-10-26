import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Backend} from './backend.ts';
import {Http, HttpError} from './http.ts';
import {distinctTasks, type Project, type Tag, type Task, type TimeEntry} from './tasks.ts';

interface Me {
    id: string;
    workspace: string;
}

/**
 * When the last workspace requests were sent; those count towards Clockify's limit, /user doesn't.
 * Module-level, so it survives the extension being disabled and enabled again on screen lock.
 */
const sent: number[] = [];

const MINUTE = 60_000;

function now(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export class ClockifyApi implements Backend {
    readonly id = 'clockify';
    readonly name = 'Clockify';
    readonly color = '#03a9f4';
    readonly keysUrl = 'https://app.clockify.me/manage-api-keys';
    readonly keyHint = 'Create one in Clockify under Preferences → Advanced → API keys';
    readonly keyName = 'API key';
    readonly missing = null;
    // The Free plan allows 30 workspace requests per hour, so everything is fetched sparingly.
    readonly pace = {entries: 15 * MINUTE, catalog: 6 * 60 * MINUTE, running: 5 * MINUTE, budget: 20};
    readonly #settings: Gio.Settings;
    readonly #http = new Http();
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

    get sentLastHour(): number {
        const hourAgo = Date.now() - 3_600_000;
        while (sent.length && sent[0] < hourAgo)
            sent.shift();
        return sent.length;
    }

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
        if (path.startsWith('/workspaces/'))
            sent.push(Date.now());
        const params = Object.entries(query)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const {data} = await this.#http.request<T>(method, `${base}${path}${params ? `?${params}` : ''}`, {
            headers: {'X-Api-Key': key ?? this.#settings.get_string('clockify-api-key')},
            body,
        });
        return data as T;
    }

    async verify(key: string): Promise<string> {
        const user = await this.#request<{name?: string; email?: string}>('GET', '/user', {key});
        return user.name || user.email || 'Clockify';
    }

    saveKey(key: string) {
        this.#settings.set_string('clockify-api-key', key);
    }

    resetKey() {
        this.#settings.reset('clockify-api-key');
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

    async fetch(known: {projects: Project[]; tags: Tag[]} | null): Promise<{tasks: Task[]; projects: Project[]; tags: Tag[]}> {
        const {workspace} = await this.#user();
        const [entries, catalog] = await Promise.all([
            this.#request<TimeEntry[]>('GET', await this.#entriesPath(), {query: {'hydrated': true, 'page-size': 200}}),
            known ?? Promise.all([
                this.#request<Project[]>('GET', `/workspaces/${workspace}/projects`, {query: {'archived': false, 'page-size': 500}}),
                this.#request<Tag[]>('GET', `/workspaces/${workspace}/tags`, {query: {'archived': false, 'page-size': 500}}),
            ]).then(([allProjects, allTags]) => ({
                // Only what parseDraft() and distinctTasks() need, to keep the cache small.
                projects: allProjects.map(({id, name, billable, clientName, color}) => ({id, name, billable, clientName, color})),
                tags: allTags.map(({id, name}) => ({id, name})),
            })),
        ]);
        const {projects, tags} = catalog;
        return {tasks: distinctTasks(entries, projects, tags), projects, tags};
    }

    async running(projects: Project[], tags: Tag[]): Promise<Task | null> {
        const entries = await this.#request<TimeEntry[]>('GET', await this.#entriesPath(),
            {query: {'in-progress': true, 'hydrated': true}});
        return entries?.length ? distinctTasks(entries.slice(0, 1), projects, tags)[0] ?? null : null;
    }

    async stop(end = now()): Promise<boolean> {
        // One request instead of asking first: Clockify answers 404 when no timer runs.
        try {
            await this.#request('PATCH', await this.#entriesPath(), {body: {end}});
            return true;
        } catch (e) {
            if (e instanceof HttpError && (e.status === 404 || e.status === 400))
                return false;
            throw e;
        }
    }

    /** Stops the running timer at the same instant, so there's no gap. */
    async start({description, projectId, taskId, tagIds, billable}: Task) {
        const {workspace} = await this.#user();
        const start = now();
        await this.stop(start);
        await this.#request('POST', `/workspaces/${workspace}/time-entries`, {
            body: {start, description, projectId, taskId, tagIds, billable},
        });
    }

    destroy() {
        this.#http.destroy();
    }
}
