import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {duration} from './tasks.ts';
import type {TimeTracking} from './tracking.ts';

const MAX_TITLE = 32;

/** The running timer in the top bar: what it is and how long it runs. */
export class TimerIndicator {
    readonly #tracking: TimeTracking;
    readonly #button: PanelMenu.Button;
    readonly #label: St.Label;
    readonly #title: PopupMenu.PopupMenuItem;
    readonly #open: PopupMenu.PopupMenuItem;
    readonly #unsubscribe: () => void;
    readonly #sources: number[];

    constructor(tracking: TimeTracking, open: () => void) {
        this.#tracking = tracking;
        this.#button = new PanelMenu.Button(0.0, 'Timer', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'system-status-icon'}));
        this.#label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this.#label);
        this.#button.add_child(box);

        const menu = this.#button.menu as PopupMenu.PopupMenu;
        this.#title = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this.#title);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Stop Timer', () => void tracking.stop());
        this.#open = new PopupMenu.PopupMenuItem('');
        this.#open.connect('activate', open);
        menu.addMenuItem(this.#open);
        Main.panel.addToStatusArea('quick-launcher-clockify', this.#button, 0, 'right');

        this.#unsubscribe = tracking.onChange(() => this.#update());
        this.#sources = [
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
                this.#update();
                // To notice timers started or stopped elsewhere.
                tracking.poll();
                return GLib.SOURCE_CONTINUE;
            }),
        ];
        tracking.load();
        this.#update();
    }

    #update() {
        const task = this.#tracking.running;
        this.#button.visible = !!task;
        if (!task)
            return;
        this.#open.label.text = `Open ${this.#tracking.name} in Quick Launcher`;
        const name = task.description || task.taskName || task.projectName || 'Timer';
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
