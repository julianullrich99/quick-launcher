import type {Project, Tag, Task} from './tasks.ts';

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

    /** Checks a key before it is saved; resolves the account's name. */
    verify(key: string): Promise<string>;
    saveKey(key: string): void;
    resetKey(): void;
    /** Distinct recent tasks, newest first, with the running one marked; and projects and tags for new ones. */
    fetch(): Promise<{tasks: Task[]; projects: Project[]; tags: Tag[]}>;
    /**
     * Whether the running timer changed since the last fetch, cheap enough to ask often.
     * Without it the provider refetches everything now and then.
     */
    runningChanged?(): Promise<boolean>;
    /** Starts a timer, stopping a running one at the same instant. */
    start(task: Task): Promise<void>;
    /** Stops the running timer. Resolves false if none was running. */
    stop(): Promise<boolean>;
    destroy(): void;
}
