import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type {Clockify} from './clockify.ts';
import {duration} from './tasks.ts';

/** How often the running timer is fetched, to notice timers started elsewhere */
const POLL_SECONDS = 120;
const MAX_TITLE = 32;

/** The running Clockify timer in the top bar: what it is and how long it runs. */
export class ClockifyIndicator {
    readonly #clockify: Clockify;
    readonly #button: PanelMenu.Button;
    readonly #label: St.Label;
    readonly #title: PopupMenu.PopupMenuItem;
    readonly #unsubscribe: () => void;
    readonly #sources: number[];

    constructor(clockify: Clockify, open: () => void) {
        this.#clockify = clockify;
        this.#button = new PanelMenu.Button(0.0, 'Clockify Timer', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'system-status-icon'}));
        this.#label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this.#label);
        this.#button.add_child(box);

        const menu = this.#button.menu as PopupMenu.PopupMenu;
        this.#title = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this.#title);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Stop Timer', () => void clockify.stop());
        menu.addAction('Open Clockify in Quick Launcher', open);
        Main.panel.addToStatusArea('quick-launcher-clockify', this.#button, 0, 'right');

        this.#unsubscribe = clockify.onChange(() => this.#update());
        this.#sources = [
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
                this.#update();
                return GLib.SOURCE_CONTINUE;
            }),
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                clockify.load(true);
                return GLib.SOURCE_CONTINUE;
            }),
        ];
        clockify.load();
        this.#update();
    }

    #update() {
        const task = this.#clockify.running;
        this.#button.visible = !!task;
        if (!task)
            return;
        const name = task.description || task.projectName || 'Timer';
        const short = name.length > MAX_TITLE ? `${name.slice(0, MAX_TITLE - 1)}…` : name;
        this.#label.text = ` ${short}  ${duration(task.lastStart)}`;
        const project = [task.projectName, task.taskName].filter(Boolean).join(': ');
        this.#title.label.text = [name, project].filter(Boolean).join(' · ');
    }

    destroy() {
        this.#sources.forEach(id => GLib.source_remove(id));
        this.#unsubscribe();
        this.#button.destroy();
    }
}
