import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {
    accelerators, keyName, matches, parseAccelerator, shortcutLabel, shortcutText,
    type Overrides, type Shortcut, type ShortcutId,
} from './shortcuts.ts';
import {createBlur} from './blur.ts';

const MAX_ROWS = 60;
/** Opacity of secondary text */
const DIM = 150;
const WIDTH = 720;

export interface Action {
    title: string;
    icon?: string;
    /** Its keys are set in the preferences, see shortcuts.ts */
    shortcut?: ShortcutId;
    destructive?: boolean;
    run(): void;
}

/** A symbolic icon or a file icon (on a colored tile if `color` is set), or a character such as an emoji. */
export type Icon =
    | {name: string; color?: string; style?: string}
    | {gicon: Gio.Icon; color?: string}
    | {text: string};

export interface Item {
    id: string;
    icon: Icon;
    title: string;
    /** Dim text right after the title */
    subtitle?: string;
    /** Dim text on the right */
    accessory?: string;
    /** Show the accessory in the accent color, e.g. "● Working" */
    accessoryActive?: boolean;
    /** Logo tile on the right, e.g. the vault an item comes from */
    source?: {icon: Gio.Icon; styleClass?: string};
    /** A calculator answer: big title with the expression below */
    answer?: boolean;
    dim?: boolean;
    /** Extra words the start view matches, e.g. "sperren" for Lock Screen */
    keywords?: string;
    /** The first action runs on Enter. */
    actions: Action[];
}

export interface Section {
    title?: string;
    items: Item[];
}

export interface View {
    /** Shown in the footer while this view is open */
    title: string;
    icon: string;
    placeholder: string;
    search(query: string): Section[];
    /** Available on every item, e.g. "Sync" with Ctrl+R */
    actions?(): Action[];
    onOpen?(): void;
}

interface Row {
    actor: St.BoxLayout;
    labels: St.BoxLayout;
    iconBox: St.Bin;
    icon: St.Icon;
    glyph: St.Label;
    title: St.Label;
    subtitle: St.Label;
    accessory: St.Label;
    source: St.Bin;
    iconStyle: string | null;
}

interface Frame {
    view: View;
    query: string;
    selectId?: string;
}

interface Prompt {
    resolve(secret: string | null): void;
    standalone: boolean;
}

/**
 * A Spotlight-style popup with a stack of views. Views return sections of
 * items; every item has actions, the first runs on Enter and all of them
 * are listed in the action panel (Ctrl+K).
 */
export class Launcher {
    readonly #backdrop: St.Widget;
    readonly #blur: St.Widget;
    readonly #box: St.BoxLayout;
    readonly #entry: St.Entry;
    readonly #entryIcon: St.Icon;
    readonly #back: St.Button;
    readonly #scroll: St.ScrollView;
    readonly #list: St.BoxLayout;
    readonly #empty: St.Label;
    readonly #footerIcon: St.Icon;
    readonly #footerText: St.Label;
    readonly #primaryLabel: St.Label;
    readonly #primaryKeys: St.BoxLayout;
    readonly #actionsHint: St.BoxLayout;
    readonly #panel: St.BoxLayout;
    readonly #panelList: St.BoxLayout;
    readonly #rows: Row[] = [];
    readonly #headers: St.Label[] = [];
    readonly #panelRows: St.BoxLayout[] = [];
    readonly #actionsKeys: St.BoxLayout;
    readonly #settings: Gio.Settings;
    readonly #settingsId: number;
    #overrides: Overrides = {};
    #stack: Frame[] = [];
    #items: Item[] = [];
    #selected = 0;
    #grab: Clutter.Grab | null = null;
    #prompt: Prompt | null = null;
    #panelActions: Action[] | null = null;
    #panelSelected = 0;
    #savedQuery = '';
    #status: string | null = null;
    #ignoreChange = false;
    /** The user moved the selection, so refreshes keep it on the same item. */
    #userSelected = false;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
        this.#settingsId = settings.connect('changed::launcher-shortcuts', () => this.#loadShortcuts());
        this.#loadShortcuts();

        this.#backdrop = new St.Widget({
            reactive: true,
            visible: false,
            constraints: new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}),
        });
        this.#backdrop.connect('button-press-event', (_actor, event: Clutter.Event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this.#box.get_transformed_position();
            const [bw, bh] = this.#box.get_transformed_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this.#box = new St.BoxLayout({style_class: 'popup-menu-content ql-box', orientation: Clutter.Orientation.VERTICAL});
        // Blur only what is behind the popup; the box gets a translucent background in open().
        this.#blur = createBlur(this.#box);
        this.#backdrop.add_child(this.#blur);
        this.#backdrop.add_child(this.#box);

        // Search bar
        const bar = new St.BoxLayout({style_class: 'ql-bar'});
        this.#back = new St.Button({
            style_class: 'icon-button ql-back',
            child: new St.Icon({icon_name: 'go-previous-symbolic'}),
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.#back.connect('clicked', () => this.pop());
        bar.add_child(this.#back);
        this.#entryIcon = new St.Icon({style_class: 'ql-entry-icon'});
        this.#entry = new St.Entry({
            style_class: 'ql-entry',
            can_focus: true,
            x_expand: true,
            primary_icon: this.#entryIcon,
        });
        bar.add_child(this.#entry);
        this.#box.add_child(bar);

        const text = this.#entry.clutter_text;
        text.connect('text-changed', () => {
            if (this.#ignoreChange || this.#prompt)
                return;
            if (this.#panelActions) {
                this.#updatePanel();
            } else {
                this.#userSelected = false;
                this.#update();
            }
        });
        text.connect('key-press-event', (_actor, event: Clutter.Event) => this.#onKeyPress(event));

        // The list, with the action panel floating over its bottom right corner
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.#list = new St.BoxLayout({style_class: 'ql-list', orientation: Clutter.Orientation.VERTICAL});
        this.#scroll = new St.ScrollView({
            style_class: 'ql-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
            child: this.#list,
            x_expand: true,
        });
        stack.add_child(this.#scroll);
        this.#empty = new St.Label({
            style_class: 'ql-empty',
            opacity: DIM,
            text: 'No results',
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        stack.add_child(this.#empty);

        this.#panel = new St.BoxLayout({
            style_class: 'popup-menu-content ql-panel',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this.#panelList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this.#panel.add_child(this.#panelList);
        stack.add_child(this.#panel);
        this.#box.add_child(stack);

        // Footer: view title or status on the left, primary action and the panel hint on the right
        const footer = new St.BoxLayout({style_class: 'ql-footer'});
        this.#footerIcon = new St.Icon({style_class: 'ql-footer-icon', y_align: Clutter.ActorAlign.CENTER, opacity: DIM});
        this.#footerText = new St.Label({style_class: 'ql-footer-text', y_align: Clutter.ActorAlign.CENTER, x_expand: true, opacity: DIM});
        this.#footerText.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.#primaryLabel = new St.Label({style_class: 'ql-footer-action', y_align: Clutter.ActorAlign.CENTER});
        this.#primaryKeys = keys([]);
        this.#actionsHint = new St.BoxLayout({style_class: 'ql-footer-actions', y_align: Clutter.ActorAlign.CENTER});
        this.#actionsHint.add_child(new St.Widget({style_class: 'popup-separator-menu-item-separator ql-footer-separator', y_align: Clutter.ActorAlign.CENTER}));
        this.#actionsHint.add_child(new St.Label({style_class: 'ql-footer-action', text: 'Actions', y_align: Clutter.ActorAlign.CENTER}));
        this.#actionsKeys = keys([]);
        this.#actionsHint.add_child(this.#actionsKeys);
        for (const child of [this.#footerIcon, this.#footerText, this.#primaryLabel, this.#primaryKeys, this.#actionsHint])
            footer.add_child(child);
        this.#box.add_child(footer);

        Main.layoutManager.uiGroup.add_child(this.#backdrop);
    }

    get isOpen(): boolean {
        return this.#grab !== null;
    }

    get view(): View | null {
        return this.#stack.at(-1)?.view ?? null;
    }

    get query(): string {
        return this.#prompt || this.#panelActions ? this.#savedQuery : this.#entry.get_text();
    }

    get selected(): Item | null {
        return this.#items[this.#selected] ?? null;
    }

    /** The open views from the bottom, with their queries; to reopen after stepping aside. */
    get stack(): Frame[] {
        const frames = this.#stack.map(f => ({...f}));
        const top = frames.at(-1);
        if (top) {
            top.query = this.query;
            top.selectId = this.selected?.id;
        }
        return frames;
    }

    /** Opens with a fresh stack: `view`, or several views from `restore`. */
    open(view: View, {query = '', selectId, restore}: {query?: string; selectId?: string; restore?: Frame[]} = {}) {
        this.#stack = restore?.length ? restore : [{view, query, selectId}];
        if (this.isOpen) {
            this.#showFrame();
            return;
        }

        const monitor = Main.layoutManager.currentMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(WIDTH * scale, monitor.width * 0.9);
        this.#box.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * 0.16));
        this.#box.width = width;

        this.#backdrop.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this.#backdrop, null);
        this.#grab = Main.pushModal(this.#backdrop, {actionMode: Shell.ActionMode.SYSTEM_MODAL});

        // Make the theme's popup background translucent so the blur shows through.
        this.#box.style = null;
        const bg = this.#box.get_theme_node().get_background_color();
        this.#box.style = `background-color: rgba(${bg.red}, ${bg.green}, ${bg.blue}, 0.75);`;

        this.#showFrame();
        for (const actor of [this.#box, this.#blur]) {
            actor.opacity = 0;
            actor.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    close() {
        const grab = this.#grab;
        if (!grab)
            return;
        this.#grab = null;
        this.#closePanel();
        this.#resolvePrompt(null);
        Main.popModal(grab);
        this.#box.remove_all_transitions();
        this.#blur.remove_all_transitions();
        this.#backdrop.hide();
        this.#status = null;
    }

    /** Opens `view` on top of the current one; Esc or Backspace goes back. */
    push(view: View, query = '', selectId?: string) {
        const current = this.#stack.at(-1);
        if (current) {
            current.query = this.#entry.get_text();
            current.selectId = this.selected?.id;
        }
        this.#stack.push({view, query, selectId});
        this.#showFrame();
    }

    pop() {
        if (this.#stack.length <= 1) {
            this.close();
            return;
        }
        this.#stack.pop();
        this.#showFrame();
    }

    /** Re-runs the search, e.g. after data arrived. Keeps the selection. */
    refresh() {
        if (this.isOpen && !this.#prompt && !this.#panelActions)
            this.#update(this.#userSelected ? this.selected?.id : undefined);
    }

    /** Opens the action panel of the selected item, like Ctrl+K. */
    showActions() {
        this.#openPanel();
    }

    /** "Ctrl+Shift+C" for a shortcut, or '' when it is turned off. */
    keyText(id: ShortcutId): string {
        const accelerator = accelerators(id, this.#overrides)[0];
        return accelerator ? shortcutText(accelerator) : '';
    }

    #loadShortcuts() {
        this.#overrides = this.#settings.get_value('launcher-shortcuts').deepUnpack() as Overrides;
    }

    #keys(id: ShortcutId): Shortcut[] {
        return accelerators(id, this.#overrides).map(parseAccelerator).filter(s => s !== null);
    }

    #is(id: ShortcutId, pressed: Shortcut): boolean {
        return this.#keys(id).some(s => matches(s, pressed));
    }

    /** Key caps of a shortcut's first keys, [] when it is turned off. */
    #label(id: ShortcutId): string[] {
        const first = this.#keys(id)[0];
        return first ? shortcutLabel(first) : [];
    }

    /** Shows a message in the footer instead of the view title. */
    setStatus(text: string | null) {
        this.#status = text;
        this.#updateFooter();
    }

    /** Turns the search field into a password field until Enter (the text) or Esc (null). */
    askSecret({prompt, description}: {prompt: string; description?: string}): Promise<string | null> {
        return this.ask({prompt, description});
    }

    /** Turns the search field into a prompt until Enter (the text) or Esc (null). */
    ask({prompt, description, secret = true, action = 'Unlock'}: {
        prompt: string;
        description?: string;
        /** Hide what is typed */
        secret?: boolean;
        /** What Enter does, shown in the footer */
        action?: string;
    }): Promise<string | null> {
        this.#resolvePrompt(null);
        this.#closePanel();
        const standalone = !this.isOpen;
        if (standalone)
            this.open({title: 'Quick Launcher', icon: 'dialog-password-symbolic', placeholder: '', search: () => []});

        this.#savedQuery = this.#entry.get_text();
        const promise = new Promise<string | null>(resolve => {
            this.#prompt = {resolve, standalone};
        });
        this.#box.add_style_pseudo_class('secret');
        this.#entryIcon.icon_name = secret ? 'system-lock-screen-symbolic' : 'document-edit-symbolic';
        this.#entry.hint_text = prompt;
        this.#entry.clutter_text.password_char = secret ? 0x2022 : 0; // •
        this.#setText('');
        this.#selectAll();
        this.#scroll.hide();
        this.#empty.hide();
        this.#back.hide();
        this.#entry.grab_key_focus();
        this.#footerIcon.icon_name = this.#entryIcon.icon_name;
        this.#footerText.text = description ?? `Enter to ${action.toLowerCase()}, Esc to cancel`;
        this.#primaryLabel.text = action;
        this.#primaryLabel.show();
        setKeys(this.#primaryKeys, this.#label('run'));
        this.#actionsHint.hide();
        return promise;
    }

    #resolvePrompt(value: string | null) {
        const prompt = this.#prompt;
        if (!prompt)
            return;
        this.#prompt = null;
        this.#box.remove_style_pseudo_class('secret');
        this.#entry.clutter_text.password_char = 0;
        this.#setText(this.#savedQuery);
        if (prompt.standalone)
            this.close();
        else if (this.isOpen)
            this.#showFrame(false);
        prompt.resolve(value);
    }

    #setText(text: string) {
        this.#ignoreChange = true;
        this.#entry.set_text(text);
        this.#ignoreChange = false;
    }

    #showFrame(resetText = true) {
        const frame = this.#stack.at(-1);
        if (!frame)
            return;
        this.#closePanel();
        this.#entryIcon.icon_name = frame.view.icon;
        this.#entry.hint_text = frame.view.placeholder;
        this.#back.visible = this.#stack.length > 1;
        if (resetText)
            this.#setText(frame.query);
        this.#userSelected = !!frame.selectId;
        frame.view.onOpen?.();
        this.#update(frame.selectId);
        this.#entry.grab_key_focus();
        this.#selectAll();
    }

    /** Selects the query, so typing replaces it. An empty one gets a plain cursor, or the first key would be selected. */
    #selectAll() {
        const length = this.#entry.get_text().length;
        if (length)
            this.#entry.clutter_text.set_selection(0, length);
        else
            this.#entry.clutter_text.set_selection(-1, -1);
    }

    #update(selectId?: string) {
        const view = this.view;
        if (!view)
            return;
        const query = this.#entry.get_text();
        const sections = view.search(query).filter(s => s.items.length > 0);

        this.#list.remove_all_children();
        this.#items = [];
        sections.forEach((section, i) => {
            if (this.#items.length >= MAX_ROWS)
                return;
            if (section.title) {
                const header = this.#header(i);
                header.text = section.title;
                this.#list.add_child(header);
            }
            for (const item of section.items.slice(0, MAX_ROWS - this.#items.length)) {
                const row = this.#row(this.#items.length);
                this.#fillRow(row, item);
                this.#list.add_child(row.actor);
                this.#items.push(item);
            }
        });

        this.#scroll.visible = this.#items.length > 0;
        this.#empty.visible = this.#items.length === 0 && query !== '';

        const index = selectId ? this.#items.findIndex(item => item.id === selectId) : -1;
        this.#select(Math.max(0, index), index > 0);
    }

    #header(index: number): St.Label {
        this.#headers[index] ??= new St.Label({style_class: 'ql-section', opacity: DIM});
        return this.#headers[index];
    }

    /** Rows are created once and reused, so typing doesn't rebuild actors. */
    #row(index: number): Row {
        const existing = this.#rows[index];
        if (existing)
            return existing;

        const actor = new St.BoxLayout({style_class: 'popup-menu-item ql-row', reactive: true, track_hover: true});
        const icon = new St.Icon({style_class: 'ql-row-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const glyph = new St.Label({style_class: 'ql-row-glyph', visible: false, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        glyph.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const iconStack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        iconStack.add_child(icon);
        iconStack.add_child(glyph);
        const iconBox = new St.Bin({style_class: 'ql-icon-box', y_align: Clutter.ActorAlign.CENTER, child: iconStack});

        const labels = new St.BoxLayout({style_class: 'ql-row-labels', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'ql-row-title', y_align: Clutter.ActorAlign.CENTER});
        const subtitle = new St.Label({style_class: 'ql-row-subtitle', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Dimmed with opacity rather than colors, so light and dark themes both work.
        subtitle.opacity = DIM;
        labels.add_child(title);
        labels.add_child(subtitle);

        const accessory = new St.Label({style_class: 'ql-row-accessory', y_align: Clutter.ActorAlign.CENTER, opacity: DIM});
        const source = new St.Bin({y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({style_class: 'ql-source-icon'})});
        for (const child of [iconBox, labels, accessory, source])
            actor.add_child(child);

        actor.connect('button-release-event', (_actor, event: Clutter.Event) => {
            this.#userSelected = true;
            this.#select(index);
            const mods = modifiers(event);
            // A plain click is the main action, a click with modifiers works like Enter with them.
            if (mods.ctrl || mods.shift || mods.alt || mods.super)
                this.#runShortcut({key: 'return', ...mods});
            else
                this.selected?.actions[0]?.run();
            return Clutter.EVENT_STOP;
        });

        const row = {actor, labels, iconBox, icon, glyph, title, subtitle, accessory, source, iconStyle: null};
        this.#rows.push(row);
        return row;
    }

    #fillRow(row: Row, item: Item) {
        const {icon} = item;
        const tile = !('text' in icon) && icon.color ? icon.color : null;
        row.glyph.visible = 'text' in icon;
        row.icon.visible = !('text' in icon);
        row.iconBox.style = tile ? `background-color: ${tile};` : null;
        toggleClass(row.iconBox, 'ql-icon-tile', !!tile);
        if ('text' in icon)
            row.glyph.text = icon.text;
        else if ('gicon' in icon)
            row.icon.gicon = icon.gicon;
        else
            row.icon.icon_name = icon.name;
        row.iconStyle = 'name' in icon && !icon.color ? icon.style ?? null : null;
        row.icon.style = row.actor.has_style_pseudo_class('selected') ? null : row.iconStyle;

        row.title.text = item.title;
        row.subtitle.text = item.subtitle ?? '';
        row.subtitle.visible = !!item.subtitle;
        row.accessory.text = item.accessory ?? '';
        row.accessory.visible = !!item.accessory;
        row.accessory.opacity = item.accessoryActive ? 255 : DIM;
        toggleClass(row.accessory, 'ql-row-accessory-active', !!item.accessoryActive);
        row.source.visible = !!item.source;
        if (item.source) {
            row.source.style_class = `ql-source ${item.source.styleClass ?? ''}`;
            (row.source.child as St.Icon).gicon = item.source.icon;
        }
        toggleClass(row.actor, 'ql-row-answer', !!item.answer);
        toggleClass(row.actor, 'ql-row-dim', !!item.dim);
        // An answer stacks the result above the expression.
        row.labels.orientation = item.answer ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    }

    #select(index: number, scroll = true) {
        const previous = this.#rows[this.#selected];
        if (previous) {
            previous.actor.remove_style_pseudo_class('selected');
            previous.icon.style = previous.iconStyle;
        }
        this.#selected = this.#items.length ? Math.max(0, Math.min(index, this.#items.length - 1)) : 0;
        const row = this.#items.length ? this.#rows[this.#selected] : null;
        if (row) {
            row.actor.add_style_pseudo_class('selected');
            row.icon.style = null;
            if (scroll)
                ensureActorVisibleInScrollView(this.#scroll, row.actor);
            else
                this.#scroll.vadjustment.value = 0;
        }
        this.#updateFooter();
    }

    #updateFooter() {
        if (this.#prompt)
            return;
        const view = this.view;
        const primary = this.selected?.actions[0];
        this.#footerIcon.icon_name = this.#status ? 'dialog-information-symbolic' : view?.icon ?? 'system-search-symbolic';
        this.#footerText.text = this.#status ?? view?.title ?? '';
        this.#primaryLabel.text = primary?.title ?? '';
        this.#primaryLabel.visible = !!primary;
        setKeys(this.#primaryKeys, primary ? this.#label('run') : []);
        setKeys(this.#actionsKeys, this.#label('actions'));
        this.#actionsHint.visible = this.#allActions().length > 1 && this.#keys('actions').length > 0;
    }

    #allActions(): Action[] {
        return [...this.selected?.actions ?? [], ...this.view?.actions?.() ?? []];
    }

    /** Runs the action whose shortcut matches, or the main one for "run". */
    #runShortcut(pressed: Shortcut): boolean {
        const action = this.#is('run', pressed)
            ? this.selected?.actions[0]
            : this.#allActions().find(a => a.shortcut && this.#is(a.shortcut, pressed));
        if (!action)
            return false;
        action.run();
        return true;
    }

    // --- Action panel ---

    #openPanel() {
        const actions = this.#allActions();
        if (actions.length === 0)
            return;
        this.#savedQuery = this.#entry.get_text();
        this.#panelActions = actions;
        this.#entry.hint_text = 'Search actions…';
        this.#setText('');
        this.#panel.show();
        this.#updatePanel();
    }

    #closePanel() {
        if (!this.#panelActions)
            return;
        this.#panelActions = null;
        this.#panel.hide();
        this.#entry.hint_text = this.view?.placeholder ?? '';
        this.#setText(this.#savedQuery);
    }

    #visiblePanelActions(): Action[] {
        const filter = this.#entry.get_text().trim().toLowerCase();
        return (this.#panelActions ?? []).filter(a => a.title.toLowerCase().includes(filter));
    }

    #updatePanel() {
        const actions = this.#visiblePanelActions();
        const primary = this.selected?.actions[0];
        this.#panelList.remove_all_children();
        actions.forEach((action, i) => {
            this.#panelRows[i] ??= this.#panelRow(i);
            const row = this.#panelRows[i];
            const [icon, label, shortcut] = row.get_children() as [St.Icon, St.Label, St.BoxLayout];
            icon.icon_name = action.icon ?? 'system-run-symbolic';
            label.text = action.title;
            setKeys(shortcut, action === primary ? this.#label('run') : action.shortcut ? this.#label(action.shortcut) : []);
            toggleClass(row, 'ql-panel-destructive', !!action.destructive);
            this.#panelList.add_child(row);
        });
        this.#selectPanel(0);
    }

    #panelRow(index: number): St.BoxLayout {
        const row = new St.BoxLayout({style_class: 'popup-menu-item ql-panel-row', reactive: true, track_hover: true});
        row.add_child(new St.Icon({style_class: 'ql-panel-icon', y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(new St.Label({style_class: 'ql-panel-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(keys([]));
        row.connect('button-release-event', () => {
            this.#selectPanel(index);
            this.#runPanel();
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    #selectPanel(index: number) {
        const count = this.#visiblePanelActions().length;
        this.#panelRows[this.#panelSelected]?.remove_style_pseudo_class('selected');
        this.#panelSelected = count ? Math.max(0, Math.min(index, count - 1)) : 0;
        if (count)
            this.#panelRows[this.#panelSelected].add_style_pseudo_class('selected');
    }

    #runPanel() {
        const action = this.#visiblePanelActions()[this.#panelSelected];
        this.#closePanel();
        action?.run();
    }

    // --- Keys ---

    #onKeyPress(event: Clutter.Event): boolean {
        const symbol = event.get_key_symbol();
        const [lower] = Clutter.keyval_convert_case(symbol);
        const pressed: Shortcut = {key: keyName(Clutter.keyval_name(lower) ?? ''), ...modifiers(event)};
        const plain = !pressed.ctrl && !pressed.shift && !pressed.alt && !pressed.super;

        if (this.#prompt) {
            if ((plain && pressed.key === 'escape') || this.#is('back', pressed))
                this.#resolvePrompt(null);
            else if ((plain && pressed.key === 'return') || this.#is('run', pressed))
                this.#resolvePrompt(this.#entry.get_text());
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }

        if (this.#panelActions) {
            if (this.#is('back', pressed) || this.#is('actions', pressed))
                this.#closePanel();
            else if (this.#is('run', pressed))
                this.#runPanel();
            else if (this.#is('previous', pressed))
                this.#selectPanel(this.#panelSelected - 1);
            else if (this.#is('next', pressed))
                this.#selectPanel(this.#panelSelected + 1);
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }

        if (this.#is('actions', pressed)) {
            this.#openPanel();
            return Clutter.EVENT_STOP;
        }

        const moves: [ShortcutId, number][] = [['previous', -1], ['next', 1], ['page-up', -8], ['page-down', 8]];
        const move = moves.find(([id]) => this.#is(id, pressed))?.[1];
        if (move !== undefined) {
            this.#userSelected = true;
            this.#select(this.#selected + move);
            return Clutter.EVENT_STOP;
        }

        if (this.#is('back', pressed)) {
            this.pop();
            return Clutter.EVENT_STOP;
        }
        if (this.#is('back-empty', pressed) && this.#entry.get_text() === '' && this.#stack.length > 1) {
            this.pop();
            return Clutter.EVENT_STOP;
        }

        // Ctrl+C with text selected in the search field copies that text.
        if (pressed.key === 'c' && pressed.ctrl && !pressed.shift && !pressed.alt && this.#entry.clutter_text.get_selection())
            return Clutter.EVENT_PROPAGATE;
        if (this.#runShortcut(pressed))
            return Clutter.EVENT_STOP;
        // Enter does nothing else; don't let it reach the entry.
        return pressed.key === 'return' ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.#settings.disconnect(this.#settingsId);
        this.close();
        this.#backdrop.destroy();
    }
}

function keys(labels: string[]): St.BoxLayout {
    const box = new St.BoxLayout({style_class: 'ql-keys', y_align: Clutter.ActorAlign.CENTER});
    setKeys(box, labels);
    return box;
}

function setKeys(box: St.BoxLayout, labels: string[]) {
    box.destroy_all_children();
    for (const label of labels)
        box.add_child(new St.Label({style_class: 'ql-kbd', text: label, y_align: Clutter.ActorAlign.CENTER}));
    box.visible = labels.length > 0;
}

function toggleClass(actor: St.Widget, name: string, on: boolean) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

function modifiers(event: Clutter.Event) {
    const state = event.get_state();
    return {
        ctrl: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
        shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
        alt: (state & Clutter.ModifierType.MOD1_MASK) !== 0,
        super: (state & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)) !== 0,
    };
}
