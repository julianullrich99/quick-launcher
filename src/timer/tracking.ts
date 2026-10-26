import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Action, Item, Launcher, Section, View} from '../lib/launcher.ts';
import {notifyError, osd} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import type {Backend} from './backend.ts';
import {ClockifyApi} from './clockify.ts';
import {ServerApi} from './server.ts';
import {duration, parseDraft, timeAgo, type Project, type Tag, type Task} from './tasks.ts';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const RECENT_PREFIX = 'clockify:';
/** How often everything is fetched again to notice timers started elsewhere, for services that can't say cheaply */
const POLL_US = 120 * GLib.USEC_PER_SEC;

interface CacheData {
    account: string;
    tasks: Task[];
    projects: Project[];
    tags: Tag[];
}

function searchFields(task: Task): Field[] {
    return [
        [10, task.description],
        [5, task.projectName],
        [5, task.taskName],
        [3, task.tagNames],
        [2, task.clientName],
    ];
}

/**
 * The last fetched tasks, projects and tags on disk, so the launcher has
 * something to show right away, even after a restart.
 */
class Cache {
    readonly #file: Gio.File;

    constructor(name: string) {
        this.#file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', `${name}.json`]));
    }

    load(account: string): CacheData | null {
        try {
            const [, bytes] = this.#file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes)) as CacheData;
            return data.account === account ? data : null;
        } catch {
            return null;
        }
    }

    async save(data: CacheData) {
        try {
            this.#file.get_parent()!.make_directory_with_parents(null);
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)))
                throw e;
        }
        await this.#file.replace_contents_async(new TextEncoder().encode(JSON.stringify(data)),
            null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

function createBackend(settings: Gio.Settings): Backend {
    return settings.get_string('time-tracker') === 'custom' ? new ServerApi(settings) : new ClockifyApi(settings);
}

/** Starts timers from recent entries or a new description, in Clockify or on a custom server. */
export class TimeTracking {
    readonly #settings: Gio.Settings;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    readonly #settingsId: number;
    #backend: Backend;
    #cache: Cache;
    #index = new SearchIndex<Task>([], searchFields);
    #projects: Project[] = [];
    #tags: Tag[] = [];
    #account: string | null = null;
    #loading = false;
    /** When everything was last requested (monotonic µs) */
    #fetchedAt = 0;
    #destroyed = false;
    #error: string | null = null;
    readonly #listeners = new Set<() => void>();

    readonly view: View;

    constructor(settings: Gio.Settings, launcher: Launcher, recents: Recents) {
        this.#settings = settings;
        this.#launcher = launcher;
        this.#recents = recents;
        this.#backend = createBackend(settings);
        this.#cache = new Cache(this.#backend.id);
        // Getters, as they follow the service in use.
        const name = () => this.name;
        const tag = () => this.#backend.id === 'custom' ? 'category' : 'tag';
        this.view = {
            get title() {
                return name();
            },
            icon: 'alarm-symbolic',
            get placeholder() {
                return `Start time entry…  @project #${tag()}`;
            },
            search: query => this.#viewSections(query),
            actions: () => this.#viewActions(),
            onOpen: () => {
                if (!this.configured)
                    this.#launcher.setStatus(`Set up ${this.name} in the preferences`);
                else if (!this.#index.items.length)
                    this.#launcher.setStatus(`Loading ${this.name}…`);
            },
        };
        this.#settingsId = settings.connect('changed::time-tracker', () => this.#switchBackend());
    }

    destroy() {
        this.#destroyed = true;
        this.#settings.disconnect(this.#settingsId);
        this.#backend.destroy();
    }

    /** The service in use, for setting it up */
    get service(): Backend {
        return this.#backend;
    }

    get name(): string {
        return this.#backend.name;
    }

    get color(): string {
        return this.#backend.color;
    }

    get configured(): boolean {
        return this.#backend.configured;
    }

    /** Why the last refresh failed, if it did */
    get error(): string | null {
        return this.#error;
    }

    /** Saves a key once the service accepts it; resolves the account's name. */
    async connect(key: string): Promise<string> {
        const name = await this.#backend.verify(key);
        this.#backend.saveKey(key);
        this.#error = null;
        this.load(true);
        return name;
    }

    /** The timer running right now, as of the last refresh */
    get running(): Task | undefined {
        return this.#index.items.find(t => t.running);
    }

    /** Calls `listener` whenever the entries or the running timer change; returns an unsubscribe function. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    disconnect() {
        this.#backend.resetKey();
        this.#clear();
    }

    #switchBackend() {
        this.#backend.destroy();
        this.#backend = createBackend(this.#settings);
        this.#cache = new Cache(this.#backend.id);
        // A request of the old one may still run; it is dropped when it ends.
        this.#loading = false;
        this.#clear();
        this.load();
    }

    #clear() {
        this.#index = new SearchIndex<Task>([], searchFields);
        this.#projects = [];
        this.#tags = [];
        this.#account = null;
        this.#error = null;
        this.#launcher.refresh();
        this.#listeners.forEach(l => l());
    }

    // --- What the launcher shows ---

    /** Best matching recent entries for the start view. */
    search(query: string, limit: number): Item[] {
        if (!query.trim() || !this.configured)
            return [];
        return this.#index.search(stripSigils(query), {all: true}).slice(0, limit).map(t => this.#item(t));
    }

    commands(): Item[] {
        if (!this.configured)
            return [];
        const running = this.running;
        return [
            {
                id: 'command:clockify',
                icon: {name: 'alarm-symbolic', color: this.color},
                title: 'Start Timer',
                subtitle: this.name,
                accessory: 'Command',
                actions: [{title: 'Open', icon: 'go-next-symbolic', run: () => this.#launcher.push(this.view)}],
            },
            ...running ? [{
                id: 'command:clockify-stop',
                icon: {name: 'media-playback-stop-symbolic', color: this.color},
                title: 'Stop Timer',
                subtitle: running.description || running.taskName || running.projectName || this.name,
                accessory: `● ${duration(running.lastStart)}`,
                accessoryActive: true,
                actions: [{title: 'Stop Timer', icon: 'media-playback-stop-symbolic', run: () => void this.stop()}],
            }] : [],
        ];
    }

    /** "Start timer “text”" for whatever was typed in the start view. */
    fallback(query: string): Item | null {
        if (!this.configured || !query.trim())
            return null;
        const draft = this.#draft(query);
        if (!draft.description && !draft.projectId)
            return null;
        return {
            ...this.#item(draft),
            id: 'clockify:fallback',
            icon: {name: 'alarm-symbolic', color: this.color},
            title: `Start Timer “${draft.description || draft.projectName}”`,
        };
    }

    recent(id: string): Item | null {
        if (!id.startsWith(RECENT_PREFIX))
            return null;
        const task = this.#index.items.find(t => t.id === id.slice(RECENT_PREFIX.length));
        return task && !task.running ? this.#item(task) : null;
    }

    #viewSections(query: string): Section[] {
        const tasks = this.#index.search(stripSigils(query));
        const draft = this.#draft(query);
        if (draft.description || draft.projectId)
            tasks.push(draft);
        return [{items: tasks.map(t => this.#item(t))}];
    }

    #viewActions(): Action[] {
        return [
            {title: 'Stop Running Timer', icon: 'media-playback-stop-symbolic', shortcut: 'stop-timer', run: () => void this.stop()},
            {title: 'Reload', icon: 'view-refresh-symbolic', shortcut: 'reload-clockify', run: () => void this.load(true)},
        ];
    }

    #item(task: Task): Item {
        const project = [task.projectName, task.taskName].filter(Boolean).join(': ');
        const tags = task.tagNames.map(t => `#${t}`).join(' ');
        const startNew: Action = {
            title: 'Start as New Entry',
            icon: 'list-add-symbolic',
            shortcut: 'start-new',
            run: () => void this.#start(this.#draft(this.#launcher.query)),
        };

        if (task.isNew) {
            return {
                id: 'new',
                icon: {name: 'list-add-symbolic'},
                title: task.description || '(no description)',
                subtitle: ['New entry', project, tags].filter(Boolean).join('  ·  '),
                actions: [{title: 'Start Timer', icon: 'media-playback-start-symbolic', run: () => void this.#start(task)}],
            };
        }
        return {
            id: task.id,
            icon: {
                name: task.running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic',
                style: task.color ? `color: ${task.color};` : undefined,
            },
            title: task.description || task.taskName || '(no description)',
            subtitle: [project, task.clientName, tags].filter(Boolean).join('  ·  '),
            accessory: task.running ? `● ${duration(task.lastStart)}` : timeAgo(task.lastStart),
            actions: task.running
                ? [{title: 'Stop Timer', icon: 'media-playback-stop-symbolic', run: () => void this.stop()}, startNew]
                : [{title: 'Start Timer', icon: 'media-playback-start-symbolic', run: () => void this.#start(task)}, startNew],
        };
    }

    #draft(query: string): Task {
        const {description, project, tags} = parseDraft(query, this.#projects, this.#tags);
        return {
            id: 'new',
            isNew: true,
            description,
            projectId: project?.id,
            billable: project?.billable ?? false,
            tagIds: tags.map(t => t.id),
            projectName: project?.name ?? '',
            clientName: project?.clientName ?? '',
            color: project?.color ?? null,
            taskName: '',
            tagNames: tags.map(t => t.name),
        };
    }

    // --- Data ---

    /** Shows cached entries right away and refreshes them in the background. */
    load(force = false) {
        if (!this.configured)
            return;
        this.#loadCache();
        if (!this.#loading || force)
            void this.#reload();
    }

    /**
     * Notices timers started or stopped elsewhere: asks the service whether the
     * running timer changed if it can tell cheaply, else refetches now and then.
     */
    poll() {
        if (!this.configured || this.#loading)
            return;
        const backend = this.#backend;
        if (backend.runningChanged) {
            // A failure shows up with the next full refresh; polling stays quiet.
            backend.runningChanged().then(changed => {
                if (changed && backend === this.#backend && !this.#destroyed)
                    void this.#reload();
            }).catch(() => {});
        } else if (GLib.get_monotonic_time() - this.#fetchedAt > POLL_US) {
            void this.#reload();
        }
    }

    #loadCache() {
        const account = this.#backend.account;
        if (this.#account === account)
            return;
        this.#account = account;
        const {tasks = [], projects = [], tags = []} = this.#cache.load(account) ?? {};
        this.#setData(tasks, projects, tags);
    }

    #setData(tasks: Task[], projects: Project[], tags: Tag[]) {
        this.#projects = projects;
        this.#tags = tags;
        this.#index = new SearchIndex(tasks, searchFields);
        this.#launcher.refresh();
        this.#listeners.forEach(l => l());
    }

    async #reload() {
        const backend = this.#backend;
        const cache = this.#cache;
        this.#loading = true;
        this.#fetchedAt = GLib.get_monotonic_time();
        try {
            const account = backend.account;
            const {tasks, projects, tags} = await backend.fetch();
            if (this.#destroyed || backend !== this.#backend)
                return;

            this.#account = account;
            this.#error = null;
            this.#setData(tasks, projects, tags);
            if (this.#launcher.view === this.view)
                this.#launcher.setStatus(null);

            cache.save({account, tasks, projects, tags}).catch(e =>
                console.error('quick-launcher: Could not write time tracking cache', e));
        } catch (e) {
            if (this.#destroyed || backend !== this.#backend)
                return;
            console.error(`quick-launcher: ${backend.name} request failed`, e);
            this.#error = (e as Error).message;
            this.#launcher.refresh();
            if (this.#launcher.view === this.view)
                this.#launcher.setStatus(`${backend.name}: ${(e as Error).message}`);
        } finally {
            if (backend === this.#backend)
                this.#loading = false;
        }
    }

    // --- Actions ---

    async #start(task: Task) {
        if (!task.description && !task.projectId && !task.taskId)
            return;
        if (!task.isNew)
            this.#recents.add(`${RECENT_PREFIX}${task.id}`);
        this.#launcher.close();
        try {
            await this.#backend.start(task);
            osd('media-playback-start-symbolic', task.description || task.taskName || task.projectName || 'Timer started');
            void this.#reload();
        } catch (e) {
            notifyError(`Could not start the ${this.name} timer`, e);
        }
    }

    async stop() {
        this.#launcher.close();
        try {
            if (await this.#backend.stop())
                osd('media-playback-stop-symbolic', 'Timer stopped');
            else
                Main.notify(this.name, 'No timer running');
            void this.#reload();
        } catch (e) {
            notifyError(`Could not stop the ${this.name} timer`, e);
        }
    }
}

function stripSigils(query: string): string {
    return query.replace(/(^|\s)[@#]/g, '$1');
}
