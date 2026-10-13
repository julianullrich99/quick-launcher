import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Action, Item, Launcher, Section, View} from '../lib/launcher.ts';
import {notifyError, osd} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {ClockifyApi} from './api.ts';
import {distinctTasks, duration, parseDraft, timeAgo, type Project, type Tag, type Task} from './tasks.ts';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

export const CLOCKIFY_COLOR = '#03a9f4';
const RECENT_PREFIX = 'clockify:';

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
    readonly #file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'clockify.json']));

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

/** Starts Clockify timers from recent entries or a new description. */
export class Clockify {
    readonly #settings: Gio.Settings;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    readonly #api: ClockifyApi;
    readonly #cache = new Cache();
    #index = new SearchIndex<Task>([], searchFields);
    #projects: Project[] = [];
    #tags: Tag[] = [];
    #account: string | null = null;
    #loading = false;
    #destroyed = false;
    #error: string | null = null;
    readonly #listeners = new Set<() => void>();

    readonly view: View;

    constructor(settings: Gio.Settings, launcher: Launcher, recents: Recents) {
        this.#settings = settings;
        this.#launcher = launcher;
        this.#recents = recents;
        this.#api = new ClockifyApi(settings);
        this.view = {
            title: 'Clockify',
            icon: 'alarm-symbolic',
            placeholder: 'Start time entry…  @project #tag',
            search: query => this.#viewSections(query),
            actions: () => this.#viewActions(),
            onOpen: () => {
                if (!this.#api.configured)
                    this.#launcher.setStatus('Set your Clockify API key in the preferences');
                else if (!this.#index.items.length)
                    this.#launcher.setStatus('Loading Clockify…');
            },
        };
    }

    destroy() {
        this.#destroyed = true;
        this.#api.destroy();
    }

    get configured(): boolean {
        return this.#api.configured;
    }

    /** Why the last refresh failed, if it did */
    get error(): string | null {
        return this.#error;
    }

    /** Saves an API key once Clockify accepts it; resolves the account's name. */
    async connect(key: string): Promise<string> {
        const name = await this.#api.verify(key);
        this.#settings.set_string('clockify-api-key', key);
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
        this.#settings.reset('clockify-api-key');
        this.#index = new SearchIndex<Task>([], searchFields);
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
                icon: {name: 'alarm-symbolic', color: CLOCKIFY_COLOR},
                title: 'Start Timer',
                subtitle: 'Clockify',
                accessory: 'Command',
                actions: [{title: 'Open', icon: 'go-next-symbolic', run: () => this.#launcher.push(this.view)}],
            },
            ...running ? [{
                id: 'command:clockify-stop',
                icon: {name: 'media-playback-stop-symbolic', color: CLOCKIFY_COLOR},
                title: 'Stop Timer',
                subtitle: running.description || running.projectName || 'Clockify',
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
            icon: {name: 'alarm-symbolic', color: CLOCKIFY_COLOR},
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
            title: task.description || '(no description)',
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

    #loadCache() {
        const account = this.#api.account;
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
        this.#loading = true;
        try {
            const account = this.#api.account;
            const [entries, allProjects, allTags] = await Promise.all([
                this.#api.recent(), this.#api.projects(), this.#api.tags(),
            ]);
            if (this.#destroyed)
                return;

            // Only what parseDraft() and distinctTasks() need, to keep the cache small.
            const projects = allProjects.map(({id, name, billable, clientName, color}) =>
                ({id, name, billable, clientName, color}));
            const tags = allTags.map(({id, name}) => ({id, name}));
            const tasks = distinctTasks(entries, projects, tags);

            this.#account = account;
            this.#error = null;
            this.#setData(tasks, projects, tags);
            if (this.#launcher.view === this.view)
                this.#launcher.setStatus(null);

            this.#cache.save({account, tasks, projects, tags}).catch(e =>
                console.error('quick-launcher: Could not write Clockify cache', e));
        } catch (e) {
            if (this.#destroyed)
                return;
            console.error('quick-launcher: Clockify request failed', e);
            this.#error = (e as Error).message;
            this.#launcher.refresh();
            if (this.#launcher.view === this.view)
                this.#launcher.setStatus(`Clockify: ${(e as Error).message}`);
        } finally {
            this.#loading = false;
        }
    }

    // --- Actions ---

    async #start(task: Task) {
        if (!task.description && !task.projectId)
            return;
        if (!task.isNew)
            this.#recents.add(`${RECENT_PREFIX}${task.id}`);
        this.#launcher.close();
        try {
            await this.#api.start(task);
            osd('media-playback-start-symbolic', task.description || task.projectName || 'Timer started');
            void this.#reload();
        } catch (e) {
            notifyError('Could not start Clockify timer', e);
        }
    }

    async stop() {
        this.#launcher.close();
        try {
            if (await this.#api.stop())
                osd('media-playback-stop-symbolic', 'Timer stopped');
            else
                Main.notify('Clockify', 'No timer running');
            void this.#reload();
        } catch (e) {
            notifyError('Could not stop Clockify timer', e);
        }
    }
}

function stripSigils(query: string): string {
    return query.replace(/(^|\s)[@#]/g, '$1');
}
