import Gio from 'gi://Gio';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import type {Item, Launcher} from '../lib/launcher.ts';
import {osd} from '../lib/output.ts';

const SYSTEM_COLOR = '#6f6f78';

interface Command {
    id: string;
    title: string;
    keywords: string;
    icon: string;
    color?: string;
    run(): void;
}

/** Lock, suspend, log out, restart, power off and a few desktop toggles. */
export class System {
    readonly #launcher: Launcher;
    readonly #interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    readonly #notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    readonly #color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});

    constructor(launcher: Launcher) {
        this.#launcher = launcher;
    }

    commands(): Item[] {
        return this.#commands().map(c => ({
            id: `system:${c.id}`,
            icon: {name: c.icon, color: c.color ?? SYSTEM_COLOR},
            title: c.title,
            subtitle: 'System',
            accessory: 'Command',
            keywords: c.keywords,
            actions: [{
                title: c.title,
                icon: c.icon,
                run: () => {
                    // Close first: the shell's own dialogs need the keyboard.
                    this.#launcher.close();
                    c.run();
                },
            }],
        }));
    }

    #commands(): Command[] {
        const system = SystemActions.getDefault() as unknown as {activateAction(id: string): void};
        const dark = this.#interface.get_string('color-scheme') === 'prefer-dark';
        const dnd = !this.#notifications.get_boolean('show-banners');
        const nightLight = this.#color.get_boolean('night-light-enabled');
        const toggle = (settings: Gio.Settings, key: string, label: string, on: boolean, icon: string) => () => {
            settings.set_boolean(key, !on);
            osd(icon, `${label} ${on ? 'off' : 'on'}`);
        };
        return [
            {id: 'lock', title: 'Lock Screen', keywords: 'sperren bildschirm lock', icon: 'system-lock-screen-symbolic', run: () => system.activateAction('lock-screen')},
            {id: 'suspend', title: 'Suspend', keywords: 'sleep bereitschaft standby ruhezustand', icon: 'weather-clear-night-symbolic', run: () => system.activateAction('suspend')},
            {id: 'logout', title: 'Log Out', keywords: 'abmelden sign out logout', icon: 'system-log-out-symbolic', run: () => system.activateAction('logout')},
            {id: 'restart', title: 'Restart', keywords: 'reboot neustart neu starten', icon: 'system-reboot-symbolic', run: () => system.activateAction('restart')},
            {id: 'power-off', title: 'Power Off', keywords: 'shutdown shut down ausschalten herunterfahren', icon: 'system-shutdown-symbolic', color: '#c01c28', run: () => system.activateAction('power-off')},
            {id: 'screenshot', title: 'Take Screenshot', keywords: 'screenshot bildschirmfoto capture', icon: 'camera-photo-symbolic', run: () => system.activateAction('open-screenshot-ui')},
            {
                id: 'dark-mode', title: dark ? 'Turn Off Dark Mode' : 'Turn On Dark Mode', keywords: 'dark mode light theme dunkel hell modus toggle',
                icon: 'weather-clear-night-symbolic', color: '#3d3846',
                run: () => {
                    this.#interface.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
                    osd('weather-clear-night-symbolic', `Dark mode ${dark ? 'off' : 'on'}`);
                },
            },
            {
                id: 'dnd', title: dnd ? 'Turn Off Do Not Disturb' : 'Turn On Do Not Disturb', keywords: 'do not disturb dnd nicht stören benachrichtigungen notifications',
                icon: 'notifications-disabled-symbolic', color: '#9141ac',
                run: () => {
                    this.#notifications.set_boolean('show-banners', dnd);
                    osd('notifications-disabled-symbolic', `Do Not Disturb ${dnd ? 'off' : 'on'}`);
                },
            },
            {
                id: 'night-light', title: nightLight ? 'Turn Off Night Light' : 'Turn On Night Light', keywords: 'night light nachtlicht blue light',
                icon: 'night-light-symbolic', color: '#e66100',
                run: toggle(this.#color, 'night-light-enabled', 'Night Light', nightLight, 'night-light-symbolic'),
            },
        ];
    }
}
