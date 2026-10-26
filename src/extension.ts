import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {ExchangeRates} from './calc/rates.ts';
import {Emoji} from './emoji/emoji.ts';
import {shortcutText} from './lib/shortcuts.ts';
import {Launcher} from './lib/launcher.ts';
import {Timers} from './lib/output.ts';
import {Recents} from './lib/recents.ts';
import {Passwords} from './passwords/passwords.ts';
import {Root} from './root.ts';
import {System} from './system/system.ts';
import {T3Code} from './t3code/t3code.ts';
import {TimerIndicator} from './timer/indicator.ts';
import {TimeTracking} from './timer/tracking.ts';

export default class QuickLauncherExtension extends Extension {
    #timers: Timers | null = null;
    #launcher: Launcher | null = null;
    #rates: ExchangeRates | null = null;
    #passwords: Passwords | null = null;
    #tracking: TimeTracking | null = null;
    #t3code: T3Code | null = null;
    #indicator: TimerIndicator | null = null;
    #shortcuts: string[] = [];
    #notification: MessageTray.Notification | null = null;

    override enable() {
        const settings = this.getSettings();
        const launcher = new Launcher(settings);
        const recents = new Recents(settings);
        this.#timers = new Timers();
        this.#launcher = launcher;
        this.#rates = new ExchangeRates();
        this.#passwords = new Passwords(settings, this.#timers, this.dir, launcher, recents);
        this.#tracking = new TimeTracking(settings, launcher, recents);
        this.#t3code = new T3Code(settings, launcher, recents);
        const root = new Root({
            settings,
            launcher,
            recents,
            rates: this.#rates,
            passwords: this.#passwords,
            tracking: this.#tracking,
            emoji: new Emoji(this.dir.get_child('emoji').get_child('emoji.json'), launcher, recents),
            system: new System(launcher),
            t3code: this.#t3code,
            openPreferences: () => this.openPreferences(),
        });

        this.#bind('open-shortcut', settings, () => {
            if (launcher.isOpen)
                launcher.close();
            else
                root.open();
        });
        this.#bind('clockify-shortcut', settings, () => {
            this.#tracking?.load();
            if (launcher.isOpen)
                launcher.close();
            else
                launcher.open(this.#tracking!.view);
        });

        this.#indicator = new TimerIndicator(this.#tracking, () => {
            this.#tracking?.load();
            launcher.open(this.#tracking!.view);
        });

        if (root.onboarding.pending)
            this.#welcome(shortcutText(settings.get_strv('open-shortcut')[0]), () => root.open());
    }

    /** Points a new user at the shortcut, once per login until they opened the launcher. */
    #welcome(shortcut: string, open: () => void) {
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title: 'Quick Launcher is ready',
            body: `Press ${shortcut} to connect your password managers and time tracking, and see what it can do.`,
            iconName: 'system-search-symbolic',
        });
        notification.connect('activated', open);
        notification.connect('destroy', () => {
            this.#notification = null;
        });
        notification.addAction('Get Started', open);
        source.addNotification(notification);
        this.#notification = notification;
    }

    #bind(key: string, settings: ReturnType<Extension['getSettings']>, handler: () => void) {
        Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handler);
        this.#shortcuts.push(key);
    }

    override disable() {
        for (const key of this.#shortcuts)
            Main.wm.removeKeybinding(key);
        this.#shortcuts = [];
        this.#notification?.destroy();
        this.#indicator?.destroy();
        this.#indicator = null;
        this.#launcher?.destroy();
        this.#passwords?.destroy();
        this.#tracking?.destroy();
        this.#t3code?.destroy();
        this.#rates?.destroy();
        this.#timers?.clear();
        this.#launcher = null;
        this.#passwords = null;
        this.#tracking = null;
        this.#t3code = null;
        this.#rates = null;
        this.#timers = null;
    }
}
