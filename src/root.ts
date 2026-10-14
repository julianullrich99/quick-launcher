import type Gio from 'gi://Gio';
import St from 'gi://St';

import {evaluate} from './calc/calculator.ts';
import type {ExchangeRates} from './calc/rates.ts';
import type {Clockify} from './clockify/clockify.ts';
import type {Emoji} from './emoji/emoji.ts';
import type {Item, Launcher, Section, View} from './lib/launcher.ts';
import {osd} from './lib/output.ts';
import type {Recents} from './lib/recents.ts';
import {normalize, SearchIndex} from './lib/search.ts';
import {Onboarding} from './onboarding.ts';
import type {Passwords} from './passwords/passwords.ts';
import type {System} from './system/system.ts';
import type {T3Code} from './t3code/t3code.ts';

const CALCULATOR_COLOR = '#ff7800';

export interface RootProviders {
    settings: Gio.Settings;
    launcher: Launcher;
    recents: Recents;
    rates: ExchangeRates;
    passwords: Passwords;
    clockify: Clockify;
    emoji: Emoji;
    system: System;
    t3code: T3Code;
    openPreferences(): void;
}

/**
 * The start view: recent items and commands when empty; while typing, the
 * calculator, matching passwords, Clockify entries and commands at once.
 */
export class Root {
    readonly #p: RootProviders;
    readonly view: View;
    readonly onboarding: Onboarding;

    constructor(providers: RootProviders) {
        this.#p = providers;
        this.view = {
            title: 'Quick Launcher',
            icon: 'system-search-symbolic',
            placeholder: 'Search passwords, sessions, timers, or calculate…',
            search: query => this.#search(query),
            onOpen: () => {
                this.#p.passwords.reload();
                this.#p.clockify.load();
                this.#p.t3code.load();
                this.#p.rates.refresh(() => this.#p.launcher.refresh());
            },
        };
        this.onboarding = new Onboarding({...providers, root: this.view});
    }

    /** Opens the start view, with Getting Started on top the first time. */
    open() {
        this.#p.launcher.open(this.view);
        if (this.onboarding.pending)
            this.#p.launcher.push(this.onboarding.view);
    }

    #commands(): Item[] {
        const {passwords, clockify, emoji, system, t3code} = this.#p;
        const t3 = t3code.command();
        const connectClockify = this.onboarding.clockifyCommand();
        return [
            ...passwords.vaultRows(),
            ...t3 ? [t3] : [],
            ...clockify.commands(),
            ...connectClockify ? [connectClockify] : [],
            ...passwords.commands(),
            emoji.command(),
            ...system.commands(),
            this.onboarding.command(),
            {
                id: 'command:settings',
                icon: {name: 'preferences-system-symbolic', color: '#6f6f78'},
                title: 'Quick Launcher Settings',
                subtitle: 'Shortcuts, vaults, Clockify',
                accessory: 'Command',
                keywords: 'preferences einstellungen config',
                actions: [{title: 'Open Settings', icon: 'preferences-system-symbolic', run: () => {
                    this.#p.launcher.close();
                    this.#p.openPreferences();
                }}],
            },
        ];
    }

    #search(query: string): Section[] {
        const text = query.trim();
        if (!text) {
            return [
                {title: 'Recent', items: this.#recent().slice(0, 6)},
                {title: 'Commands', items: this.#commands()},
            ];
        }

        const commands = new SearchIndex(this.#commands(), item => [
            [10, item.title], [4, item.keywords?.split(' ')], [2, item.subtitle],
        ]).search(text, {all: true}).slice(0, 6);
        // A command whose name starts with the query goes first ("lock", "sus…").
        const strong = commands.length > 0 && normalize(commands[0].title).startsWith(normalize(text));

        // Recently used matches first, newest first, so what is searched often is right on top.
        const recent = this.#recent();
        const matches = new Set(new SearchIndex(recent, item => [
            [10, item.title], [5, item.subtitle], [2, item.keywords?.split(' ')],
        ]).search(text, {all: true}));
        const recentMatches = recent.filter(item => matches.has(item)).slice(0, 4);
        const shown = new Set(recentMatches.map(item => item.id));
        const rest = (items: Item[]) => items.filter(item => !shown.has(item.id));

        const sections: Section[] = [];
        const answer = this.#answer(text);
        if (answer)
            sections.push({items: [answer]});
        sections.push({title: 'Recent', items: recentMatches});
        if (strong)
            sections.push({title: 'Commands', items: commands});
        if (text.startsWith(':'))
            sections.push({title: 'Emoji', items: rest(this.#p.emoji.search(text.slice(1), 8))});
        sections.push({title: 'Passwords', items: rest(this.#p.passwords.search(text, 5))});
        sections.push({title: 'T3 Code', items: rest(this.#p.t3code.search(text, 5))});
        sections.push({title: 'Clockify', items: rest(this.#p.clockify.search(text, 4))});
        if (!strong)
            sections.push({title: 'Commands', items: commands});
        // Offer "Start timer …" etc. only when the query isn't obviously something else.
        if (!answer && !text.startsWith(':'))
            sections.push({title: `Use “${text}” with…`, items: this.#fallbacks(text)});
        return sections;
    }

    /** Recently used items, newest first */
    #recent(): Item[] {
        const {recents, clockify, passwords, emoji, t3code} = this.#p;
        // The running timer is under Commands as "Stop Timer", not here where Enter would stop it.
        return recents.ids
            .map(id => passwords.recent(id) ?? clockify.recent(id) ?? t3code.recent(id) ?? emoji.recent(id))
            .filter((item): item is Item => item !== null);
    }

    #answer(text: string): Item | null {
        const settings = this.#p.settings;
        const result = evaluate(text, {
            rates: this.#p.rates.rates,
            defaultCurrency: settings.get_string('default-currency') || 'EUR',
        });
        if (!result)
            return null;
        const copy = (value: string, label: string) => () => {
            this.#p.launcher.close();
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value);
            osd('edit-copy-symbolic', label);
        };
        return {
            id: 'calculator',
            icon: {name: 'accessories-calculator-symbolic', color: CALCULATOR_COLOR},
            title: result.display,
            subtitle: result.expression,
            accessory: 'Calculator',
            answer: true,
            actions: [
                {title: 'Copy Answer', icon: 'edit-copy-symbolic', run: copy(result.copy, `${result.display} copied`)},
                {
                    title: 'Copy as Shown', icon: 'edit-copy-symbolic', shortcut: 'copy-shown',
                    run: copy(result.display, `${result.display} copied`),
                },
                {
                    title: 'Copy Question and Answer', icon: 'edit-copy-symbolic', shortcut: 'copy-question',
                    run: copy(`${text} = ${result.display}`, 'Copied'),
                },
            ],
        };
    }

    #fallbacks(text: string): Item[] {
        const {launcher, passwords, clockify, emoji} = this.#p;
        const fallback = clockify.fallback(text);
        return [
            ...fallback ? [fallback] : [],
            {
                id: 'fallback:passwords',
                icon: {name: 'dialog-password-symbolic', color: '#3584e4'},
                title: `Search Passwords for “${text}”`,
                actions: [{title: 'Search', icon: 'system-search-symbolic', run: () => launcher.push(passwords.view, text)}],
            },
            {
                id: 'fallback:emoji',
                icon: {name: 'face-smile-symbolic', color: '#e5a50a'},
                title: `Search Emoji for “${text.replace(/^:/, '')}”`,
                actions: [{title: 'Search', icon: 'system-search-symbolic', run: () => launcher.push(emoji.view, text.replace(/^:/, ''))}],
            },
        ];
    }
}
