import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {timeAgo} from '../timer/tasks.ts';
import type {Item, Launcher, View} from '../lib/launcher.ts';
import {notifyError} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {findProgram, run} from '../lib/subprocess.ts';

const RECENT_PREFIX = 't3:';
const REFRESH_SECONDS = 2;

/**
 * Active threads: not archived, deleted or settled, and not a subagent's
 * backing thread. The newest unfinished run tells whether it is working.
 */
const QUERY = `
SELECT t.thread_id AS id, t.title, t.updated_at AS updatedAt, p.title AS project,
  json_extract(t.payload_json, '$.branch') AS branch,
  json_extract(t.payload_json, '$.snoozedUntil') AS snoozedUntil,
  r.status AS runStatus, r.requested_at AS runSince
FROM orchestration_v2_projection_threads t
LEFT JOIN projection_projects p ON p.project_id = t.project_id
LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
  SELECT run_id FROM orchestration_v2_projection_runs
  WHERE thread_id = t.thread_id AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
  ORDER BY ordinal DESC LIMIT 1)
WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
  AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
  AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NULL
ORDER BY t.updated_at DESC;`;

interface Session {
    id: string;
    title: string;
    updatedAt: string;
    project: string | null;
    branch: string | null;
    snoozedUntil: string | null;
    runStatus: string | null;
    runSince: string | null;
}

/** Searches active T3 Code threads and opens them in the app. */
export class T3Code {
    readonly #settings: Gio.Settings;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    #index = new SearchIndex<Session>([], searchFields);
    #icon: Gio.Icon | null = null;
    #refreshId = 0;
    #loading = false;
    #error: string | null = null;

    readonly view: View;

    constructor(settings: Gio.Settings, launcher: Launcher, recents: Recents) {
        this.#settings = settings;
        this.#launcher = launcher;
        this.#recents = recents;
        this.view = {
            title: 'T3 Code',
            icon: 'utilities-terminal-symbolic',
            placeholder: 'Search active T3 Code sessions…',
            search: query => [{items: this.#sorted(this.#index.search(query)).map(s => this.#item(s))}],
            onOpen: () => {
                this.load();
                if (this.#error)
                    this.#launcher.setStatus(`T3 Code: ${this.#error}`);
            },
        };
    }

    destroy() {
        if (this.#refreshId)
            GLib.source_remove(this.#refreshId);
        this.#refreshId = 0;
    }

    get #dataDir(): string {
        return this.#settings.get_string('t3code-data-dir') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.t3', 'userdata']);
    }

    get #database(): string {
        return GLib.build_filenamev([this.#dataDir, 'statev2.sqlite']);
    }

    /** T3 Code is installed (handles t3code:// links), has state on disk, and sqlite3 can read it. */
    get available(): boolean {
        return this.#settings.get_boolean('t3code-enabled') &&
            findHandler() !== null &&
            GLib.file_test(this.#database, GLib.FileTest.EXISTS) &&
            findProgram('sqlite3') !== null;
    }

    // --- What the launcher shows ---

    search(query: string, limit: number): Item[] {
        if (!query.trim() || !this.available)
            return [];
        return this.#index.search(query, {all: true}).slice(0, limit).map(s => this.#item(s));
    }

    command(): Item | null {
        if (!this.available)
            return null;
        const working = this.#index.items.filter(isWorking).length;
        return {
            id: 'command:t3code',
            icon: this.#appIcon(),
            title: 'Search T3 Code Sessions',
            subtitle: `${this.#index.items.length} active${working ? ` · ${working} working` : ''}`,
            accessory: 'Command',
            keywords: 't3 code threads sessions agents',
            actions: [{title: 'Open', icon: 'go-next-symbolic', run: () => this.#launcher.push(this.view)}],
        };
    }

    recent(id: string): Item | null {
        if (!id.startsWith(RECENT_PREFIX) || !this.available)
            return null;
        const session = this.#index.items.find(s => s.id === id.slice(RECENT_PREFIX.length));
        return session ? this.#item(session) : null;
    }

    /** Working sessions first, then the most recently updated. */
    #sorted(sessions: Session[]): Session[] {
        return [...sessions].sort((a, b) => Number(!!b.runStatus) - Number(!!a.runStatus));
    }

    #item(session: Session): Item {
        return {
            id: `${RECENT_PREFIX}${session.id}`,
            icon: this.#appIcon(),
            title: session.title || '(untitled)',
            subtitle: [session.project, session.branch].filter(Boolean).join('  ·  '),
            accessory: status(session),
            accessoryActive: !!session.runStatus,
            actions: [
                {title: 'Open in T3 Code', icon: 'go-next-symbolic', run: () => this.#open(session)},
                {
                    title: 'Copy Link', icon: 'edit-copy-symbolic', shortcut: 'copy-link',
                    run: () => {
                        this.#launcher.close();
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this.#link(session));
                    },
                },
            ],
        };
    }

    #appIcon(): Item['icon'] {
        this.#icon ??= findHandler()?.get_icon() ?? null;
        return this.#icon ? {gicon: this.#icon} : {name: 'utilities-terminal-symbolic', color: '#1c1c1f'};
    }

    #link(session: Session): string {
        let environment = '';
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([this.#dataDir, 'environment-id']));
            environment = new TextDecoder().decode(bytes).trim();
        } catch {}
        return `t3code://threads/${encodeURIComponent(environment)}/${encodeURIComponent(session.id)}`;
    }

    #open(session: Session) {
        this.#recents.add(`${RECENT_PREFIX}${session.id}`);
        this.#launcher.close();
        try {
            const app = findHandler();
            if (!app)
                throw new Error('No app handles t3code:// links');
            app.launch_uris([this.#link(session)], null);
        } catch (e) {
            notifyError('Could not open T3 Code', e);
        }
    }

    // --- Data ---

    /** Reads the sessions now and every few seconds while the launcher is open, so status and times stay live. */
    load() {
        if (!this.available)
            return;
        void this.#reload();
        if (this.#refreshId)
            return;
        this.#refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            if (!this.#launcher.isOpen) {
                this.#refreshId = 0;
                return GLib.SOURCE_REMOVE;
            }
            void this.#reload();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async #reload() {
        if (this.#loading)
            return;
        this.#loading = true;
        try {
            // Read-only, so T3 Code's own writes are never blocked or touched.
            const {stdout} = await run(['sqlite3', '-readonly', '-json', `file:${this.#database}?mode=ro`, QUERY]);
            this.#index = new SearchIndex(JSON.parse(stdout || '[]') as Session[], searchFields);
            this.#error = null;
            this.#launcher.refresh();
        } catch (e) {
            this.#error = (e as Error).message;
            console.warn('quick-launcher: Could not read T3 Code sessions', e);
        } finally {
            this.#loading = false;
        }
    }
}

function isWorking(session: Session): boolean {
    return ['running', 'starting', 'preparing'].includes(session.runStatus ?? '');
}

/** The app that opens t3code:// links: the default, or any that registered the scheme. */
function findHandler(): Gio.AppInfo | null {
    return Gio.AppInfo.get_default_for_uri_scheme('t3code') ??
        Gio.AppInfo.get_all_for_type('x-scheme-handler/t3code')[0] ?? null;
}

function searchFields(session: Session): Field[] {
    return [[10, session.title], [4, session.project ?? undefined], [2, session.branch ?? undefined]];
}

/** "45 s", "12 min", "1 h 05" */
function elapsed(since: string | null): string {
    const seconds = since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000)) : 0;
    if (seconds < 60)
        return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** "● Working · 12:04", "Waiting for you", "Snoozed", or when it last changed */
function status(session: Session): string {
    switch (session.runStatus) {
    case 'running':
    case 'starting':
    case 'preparing':
        return `● Working · ${elapsed(session.runSince)}`;
    case 'queued':
        return '● Queued';
    case 'waiting':
        return '● Waiting for you';
    }
    if (session.snoozedUntil && Date.parse(session.snoozedUntil) > Date.now())
        return 'Snoozed';
    return timeAgo(session.updatedAt);
}
