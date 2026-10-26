// Pure helpers for time tracking; no GNOME imports, so they're unit tested.
import {normalize} from '../lib/search.ts';

export interface Project {
    id: string;
    name: string;
    billable?: boolean;
    clientName?: string;
    color?: string;
}

export interface Tag {
    id: string;
    name: string;
}

/** A time entry as returned by GET /time-entries?hydrated=true (subset). */
export interface TimeEntry {
    description?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    tagIds?: string[] | null;
    billable?: boolean;
    project?: {id: string; name?: string; color?: string; clientName?: string} | null;
    task?: {id: string; name?: string} | null;
    tags?: Tag[] | null;
    timeInterval?: {start?: string; end?: string | null};
}

/** Something that can be started: a distinct recent entry or a new one. */
export interface Task {
    id: string;
    description: string;
    projectId?: string;
    taskId?: string;
    tagIds: string[];
    billable: boolean;
    projectName: string;
    clientName: string;
    color: string | null;
    taskName: string;
    tagNames: string[];
    /** Start of the newest entry with these values (ISO) */
    lastStart?: string;
    running?: boolean;
    isNew?: boolean;
}

/** Collapses the time entry history into distinct recent tasks, newest first. */
export function distinctTasks(entries: TimeEntry[], projects: Project[], tags: Tag[]): Task[] {
    const projectsById = new Map(projects.map(p => [p.id, p]));
    const tagsById = new Map(tags.map(t => [t.id, t]));
    const seen = new Map<string, Task>();

    for (const e of entries) {
        const projectId = e.projectId ?? e.project?.id ?? undefined;
        const taskId = e.taskId ?? e.task?.id ?? undefined;
        const tagIds = e.tagIds ?? e.tags?.map(t => t.id) ?? [];
        const description = e.description ?? '';
        const id = JSON.stringify([description, projectId, taskId, [...tagIds].sort(), !!e.billable]);
        if (seen.has(id))
            continue;

        const project = (projectId && projectsById.get(projectId)) || e.project;
        seen.set(id, {
            id,
            description,
            projectId,
            taskId,
            tagIds,
            billable: !!e.billable,
            projectName: project?.name ?? '',
            clientName: project?.clientName ?? '',
            color: project?.color ?? null,
            taskName: e.task?.name ?? '',
            tagNames: tagIds
                .map(t => tagsById.get(t)?.name ?? e.tags?.find(tag => tag.id === t)?.name)
                .filter((name): name is string => !!name),
            lastStart: e.timeInterval?.start,
            running: !!e.timeInterval?.start && !e.timeInterval?.end,
        });
    }
    return [...seen.values()];
}

/** An entry of a custom time tracking server, from GET /timer or GET /entries/recent (subset). */
export interface ServerEntry {
    description?: string | null;
    projectId?: string | null;
    project?: string | null;
    taskId?: string | null;
    task?: {name?: string; project?: string} | null;
    categoryId?: string | null;
    category?: {name?: string; color?: string} | null;
    /** When the running entry started */
    startedAt?: string;
    /** When a recent combination was last started */
    lastUsedAt?: string;
}

/**
 * The server's recent combinations as tasks, with the running entry first.
 * Its category is the one tag a task can have.
 */
export function serverTasks(recent: ServerEntry[], running: ServerEntry | null): Task[] {
    const toTask = (e: ServerEntry, lastStart: string | undefined, isRunning: boolean): Task => ({
        id: JSON.stringify([e.description ?? '', e.taskId ?? null, e.projectId ?? null, e.categoryId ?? null]),
        description: e.description ?? '',
        projectId: e.projectId ?? undefined,
        taskId: e.taskId ?? undefined,
        tagIds: e.categoryId ? [e.categoryId] : [],
        billable: false,
        projectName: e.project || e.task?.project || '',
        clientName: '',
        color: e.category?.color ?? null,
        taskName: e.task?.name ?? '',
        tagNames: e.category?.name ? [e.category.name] : [],
        lastStart,
        running: isRunning,
    });

    const tasks = recent.map(e => toTask(e, e.lastUsedAt, false));
    if (running) {
        const task = toTask(running, running.startedAt, true);
        return [task, ...tasks.filter(t => t.id !== task.id)];
    }
    return tasks;
}

function findByName<T extends {name: string}>(items: T[], token: string): T | null {
    const wanted = normalize(token);
    const names = items.map(item => [item, normalize(item.name).replace(/\s+/g, '')] as const);
    return (names.find(([, n]) => n === wanted) ??
        names.find(([, n]) => n.startsWith(wanted)) ??
        names.find(([, n]) => n.includes(wanted)))?.[0] ?? null;
}

/**
 * Turns "Fix login @proj #tag" into a description plus the first matching
 * project and tags. Words whose @/# reference matches nothing stay text.
 */
export function parseDraft(query: string, projects: Project[], tags: Tag[]) {
    const words: string[] = [];
    let project: Project | null = null;
    const picked: Tag[] = [];

    for (const word of query.split(/\s+/).filter(Boolean)) {
        const [sigil, name] = [word[0], word.slice(1)];
        const match = !name ? null
            : sigil === '@' && !project ? findByName(projects, name)
                : sigil === '#' ? findByName(tags, name) : null;

        if (!match)
            words.push(word);
        else if (sigil === '@')
            project = match as Project;
        else if (!picked.includes(match as Tag))
            picked.push(match as Tag);
    }

    return {description: words.join(' '), project, tags: picked};
}

/** "now", "5m", "3h", "yesterday", "4d", "3w" */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
    if (!iso)
        return '';
    const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
    if (!(minutes >= 0))
        return '';
    if (minutes < 1)
        return 'now';
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days === 1)
        return 'yesterday';
    return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** "0:07", "1:23" */
export function duration(fromIso: string | undefined, now = Date.now()): string {
    if (!fromIso)
        return '';
    const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
