import type {Project, Tag, Task} from './tasks.ts';

/** How sparingly the provider asks a service; ages in milliseconds */
export interface Pace {
    /** Recent entries are refetched when the launcher opens, at most this often */
    entries: number;
    /** Projects and tags; Reload fetches them right away */
    catalog: number;
    /** The running timer is checked at most this often, to notice timers started elsewhere */
    running: number;
    /** Automatic requests stop at this many per hour, leaving the rest for starting and stopping timers */
    budget: number;
}

/** What the time tracking provider needs from a service: Clockify or a custom server. */
export interface Backend {
    /** "clockify" or "custom", for the cache file */
    readonly id: string;
    /** Shown in the launcher */
    readonly name: string;
    readonly color: string;
    /** Where to create an API key, if the service has such a page */
    readonly keysUrl: string | null;
    /** How to get a key, shown when asking for one */
    readonly keyHint: string;
    /** What a key is called, e.g. "API key" */
    readonly keyName: string;
    /** Set up: has a key, and whatever else it needs */
    readonly configured: boolean;
    /** Identifies the account, so a cache never shows another account's data. */
    readonly account: string;
    /** Something else to ask before the key, like a server URL; null when nothing is missing */
    readonly missing: {setting: string; prompt: string; description: string} | null;
    readonly pace: Pace;
    /** Requests counting towards the service's hourly limit, sent within the last hour */
    readonly sentLastHour: number;

    /** Checks a key before it is saved; resolves the account's name. */
    verify(key: string): Promise<string>;
    saveKey(key: string): void;
    resetKey(): void;
    /**
     * Distinct recent tasks, newest first, with the running one marked; and projects and tags for new ones.
     * With `known` projects and tags, the service may use those instead of fetching them again.
     */
    fetch(known: {projects: Project[]; tags: Tag[]} | null): Promise<{tasks: Task[]; projects: Project[]; tags: Tag[]}>;
    /** The running timer, with one request; undefined if it didn't change since the last fetch. */
    running(projects: Project[], tags: Tag[]): Promise<Task | null | undefined>;
    /** Starts a timer, stopping a running one at the same instant. */
    start(task: Task): Promise<void>;
    /** Stops the running timer. Resolves false if none was running. */
    stop(): Promise<boolean>;
    destroy(): void;
}
