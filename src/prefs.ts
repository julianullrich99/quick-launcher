import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CURRENCIES} from './calc/units.ts';
import {
    GROUPS, SHORTCUTS, accelerators, conflicts, type Overrides, type ShortcutGroup, type ShortcutId,
} from './lib/shortcuts.ts';
import {findProgram} from './lib/subprocess.ts';
import {setPinentryBridge} from './passwords/bridge.ts';
import {rbwConfig, setRbwConfig, type RbwConfig} from './passwords/rbw.ts';

export default class QuickLauncherPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);
        window.add(generalPage(settings));
        window.add(this.#passwordsPage(settings));
        window.add(clockifyPage(settings));
        window.add(shortcutsPage(settings));
    }

    #passwordsPage(settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({title: 'Passwords', icon_name: 'dialog-password-symbolic'});

        const bitwarden = new Adw.PreferencesGroup({
            title: 'Bitwarden',
            description: 'Through rbw (https://github.com/doy/rbw), on bitwarden.com, the EU cloud or a self-hosted server',
        });
        bitwarden.add(switchRow(settings, 'bitwarden-enabled', 'Enabled'));
        bitwarden.add(programRow(settings, 'rbw-path', 'rbw binary'));
        bitwarden.add(rbwConfigRow(settings, 'email', 'Account email'));
        bitwarden.add(rbwConfigRow(settings, 'server', 'Server (empty = bitwarden.com)'));
        bitwarden.add(this.#pinentryRow(settings));
        page.add(bitwarden);

        const onePassword = new Adw.PreferencesGroup({
            title: '1Password',
            description: 'Through the 1Password CLI (op)',
        });
        onePassword.add(switchRow(settings, 'onepassword-enabled', 'Enabled'));
        onePassword.add(programRow(settings, 'op-path', 'op binary'));

        const account = new Adw.EntryRow({title: 'Account (empty = default)', show_apply_button: true});
        settings.bind('onepassword-account', account, 'text', Gio.SettingsBindFlags.DEFAULT);
        onePassword.add(account);

        const methods = [
            ['auto', 'Automatic', 'Desktop app if installed, otherwise master password'],
            ['app', 'Desktop app', 'Needs “Integrate with 1Password CLI” in the app’s developer settings'],
            ['password', 'Master password', 'Typed into the launcher; the session lives in memory only'],
        ] as const;
        onePassword.add(choiceRow(settings, 'onepassword-unlock', 'Unlock with', methods));
        page.add(onePassword);

        const browser = new Adw.PreferencesGroup({
            title: 'Log in on websites',
            description: '“Open and Log In” opens an item’s website in your browser, then presses the autofill shortcut of the Bitwarden or 1Password browser extension. Set the same shortcut in the browser, e.g. chrome://extensions/shortcuts',
        });
        browser.add(choiceRow(settings, 'password-action', 'Enter on a password', [
            ['login', 'Open and log in', 'Copies the password for items without a website'],
            ['copy', 'Copy password', 'The website is still in the action panel'],
            ['type', 'Type password', 'The website is still in the action panel'],
        ]));
        for (const [key, title] of [
            ['bitwarden-autofill-keys', 'Bitwarden extension “Autofill login” shortcut (empty = only open)'],
            ['onepassword-autofill-keys', '1Password extension autofill shortcut'],
        ]) {
            const row = new Adw.EntryRow({title, show_apply_button: true});
            settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            browser.add(row);
        }
        browser.add(spinRow(settings, 'autofill-delay-ms', 'Wait for the website', 'Milliseconds before the login is filled', 15000, 100));
        page.add(browser);

        const output = new Adw.PreferencesGroup({title: 'Copy and type'});
        output.add(spinRow(settings, 'clear-clipboard-seconds', 'Clear clipboard after', 'Seconds, 0 = never', 3600, 5));
        output.add(switchRow(settings, 'scrub-clipboard-history', 'Remove secrets from Clipboard Indicator history'));
        output.add(spinRow(settings, 'type-delay-ms', 'Delay between typed keys', 'Milliseconds; raise this if characters get lost', 200, 1));
        output.add(switchRow(settings, 'submit-after-password', 'Press Enter after typing a password'));
        page.add(output);

        return page;
    }

    /** Answers rbw's password prompt in the launcher; see setPinentryBridge(). */
    #pinentryRow(settings: Gio.Settings): Adw.SwitchRow {
        const row = new Adw.SwitchRow({
            title: 'Enter master password in the launcher',
            subtitle: 'Sets rbw’s pinentry to a bridge script; turning this off restores the previous one',
            active: settings.get_boolean('rbw-pinentry-bridge'),
        });
        row.connect('notify::active', async () => {
            if (row.active === settings.get_boolean('rbw-pinentry-bridge'))
                return;
            try {
                await setPinentryBridge(settings, row.active, this.dir);
                row.remove_css_class('error');
            } catch (e) {
                console.error('quick-launcher: Could not configure rbw pinentry', e);
                row.subtitle = `Failed: ${(e as Error).message}`;
                row.add_css_class('error');
                row.active = settings.get_boolean('rbw-pinentry-bridge');
            }
        });
        // Getting Started in the launcher turns it on too.
        const id = settings.connect('changed::rbw-pinentry-bridge', () => {
            row.active = settings.get_boolean('rbw-pinentry-bridge');
        });
        row.connect('destroy', () => settings.disconnect(id));
        return row;
    }
}

function generalPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'system-search-symbolic'});

    const launcher = new Adw.PreferencesGroup({
        description: 'One launcher for passwords, Clockify, the calculator, emoji and system commands. Start typing to search everything at once.',
    });
    launcher.add(shortcutRow(settings, 'open-shortcut', 'Open launcher'));
    page.add(launcher);

    const calculator = new Adw.PreferencesGroup({
        title: 'Calculator',
        description: 'Exchange rates are the European Central Bank\'s daily reference rates, fetched at most twice a day',
    });
    const currency = new Adw.ComboRow({
        title: 'Default currency',
        subtitle: 'Amounts like “100 usd” are converted to it',
        model: Gtk.StringList.new(CURRENCIES),
        selected: Math.max(0, CURRENCIES.indexOf(settings.get_string('default-currency'))),
    });
    currency.connect('notify::selected', () => settings.set_string('default-currency', CURRENCIES[currency.selected]));
    calculator.add(currency);
    page.add(calculator);

    const t3 = new Adw.PreferencesGroup({
        title: 'T3 Code',
        description: Gio.AppInfo.get_default_for_uri_scheme('t3code') ?? Gio.AppInfo.get_all_for_type('x-scheme-handler/t3code')[0]
            ? 'Active sessions (not settled or archived) show up in the search, with whether they are working right now'
            : 'T3 Code doesn’t seem to be installed; sessions show up once it is',
    });
    t3.add(switchRow(settings, 't3code-enabled', 'Search T3 Code sessions'));
    const dataDir = new Adw.EntryRow({title: 'Data directory (empty = ~/.t3/userdata)', show_apply_button: true});
    settings.bind('t3code-data-dir', dataDir, 'text', Gio.SettingsBindFlags.DEFAULT);
    t3.add(dataDir);
    page.add(t3);

    const history = new Adw.PreferencesGroup();
    const clear = new Adw.ActionRow({title: 'Recently used items', subtitle: 'Shown when the launcher opens'});
    const button = new Gtk.Button({label: 'Clear', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => settings.set_strv('recent', []));
    clear.add_suffix(button);
    history.add(clear);
    page.add(history);
    return page;
}

function clockifyPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title: 'Clockify', icon_name: 'alarm-symbolic'});

    const general = new Adw.PreferencesGroup({
        description: 'Start timers from your recent time entries, or a new one with @project and #tags',
    });
    general.add(shortcutRow(settings, 'clockify-shortcut', 'Open Clockify directly'));
    page.add(general);

    const api = new Adw.PreferencesGroup({
        title: 'API',
        description: 'Create a key under Clockify → Profile settings → API',
    });
    const key = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
    settings.bind('clockify-api-key', key, 'text', Gio.SettingsBindFlags.DEFAULT);
    api.add(key);

    const url = new Adw.EntryRow({title: 'API URL (regional: https://euc1.clockify.me/api/v1)', show_apply_button: true});
    settings.bind('clockify-api-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
    api.add(url);
    page.add(api);

    return page;
}

function shortcutsPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({name: 'shortcuts', title: 'Shortcuts', icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic'});

    const global = new Adw.PreferencesGroup({
        title: 'Anywhere',
        description: 'These work everywhere in GNOME. Click a shortcut to change it.',
    });
    global.add(shortcutRow(settings, 'open-shortcut', 'Open launcher'));
    global.add(shortcutRow(settings, 'clockify-shortcut', 'Open Clockify directly'));
    page.add(global);

    const groups = new Map<ShortcutGroup, Adw.PreferencesGroup>();
    for (const shortcut of SHORTCUTS) {
        let group = groups.get(shortcut.group);
        if (!group) {
            group = new Adw.PreferencesGroup({title: GROUPS[shortcut.group]});
            groups.set(shortcut.group, group);
            page.add(group);
        }
        group.add(launcherShortcutRow(settings, shortcut.id, shortcut.title));
    }

    const reset = new Gtk.Button({label: 'Reset All', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    reset.connect('clicked', () => settings.reset('launcher-shortcuts'));
    groups.get('launcher')!.header_suffix = reset;
    groups.get('launcher')!.description = 'Inside the launcher. Each action lists its keys in the action panel.';
    return page;
}

function overrides(settings: Gio.Settings): Overrides {
    return settings.get_value('launcher-shortcuts').deepUnpack() as Overrides;
}

function setOverride(settings: Gio.Settings, id: ShortcutId, keys: string[] | null) {
    const all = overrides(settings);
    const defaults = SHORTCUTS.find(s => s.id === id)!.defaults as readonly string[];
    if (keys === null || (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])))
        delete all[id];
    else
        all[id] = keys;
    settings.set_value('launcher-shortcuts', new GLib.Variant('a{sas}', all as Record<string, string[]>));
}

/** A shortcut inside the launcher: click to record, the arrow resets it. Warns about clashes. */
function launcherShortcutRow(settings: Gio.Settings, id: ShortcutId, title: string): Adw.ActionRow {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: 'Reset to default',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => setOverride(settings, id, null));
    row.add_suffix(label);
    row.add_suffix(reset);

    const sync = () => {
        const all = overrides(settings);
        label.accelerator = accelerators(id, all).join(' ');
        reset.visible = all[id] !== undefined;
        const clashes = conflicts(id, all).map(other => SHORTCUTS.find(s => s.id === other)!.title);
        row.subtitle = clashes.length ? `Same keys as: ${clashes.join(', ')}` : '';
        if (clashes.length)
            row.add_css_class('warning');
        else
            row.remove_css_class('warning');
    };
    sync();
    const changed = settings.connect('changed::launcher-shortcuts', sync);
    row.connect('destroy', () => settings.disconnect(changed));

    row.connect('activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: 'Press the new keys, or Esc to cancel. Keys that type text need Ctrl, Alt or Super.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('off', 'Turn Off');
        dialog.set_response_appearance('off', Adw.ResponseAppearance.DESTRUCTIVE);
        const add = new Gtk.CheckButton({label: 'Keep the current keys too', halign: Gtk.Align.CENTER});
        dialog.extra_child = add;
        dialog.connect('response', (_dialog, response: string) => {
            if (response === 'off')
                setOverride(settings, id, []);
        });

        // In the capture phase, so Enter and Tab can be recorded too. Esc cancels; Reset brings it back for "Go back".
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_controller, keyval: number, keycode: number, state: Gdk.ModifierType) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return Gdk.EVENT_STOP;
            const char = Gdk.keyval_to_unicode(keyval);
            if (char >= 0x20 && char !== 0x7f && (mods & ~Gdk.ModifierType.SHIFT_MASK) === 0) {
                dialog.body = 'Keys that type text need Ctrl, Alt or Super, or they would end up in the search.';
                return Gdk.EVENT_STOP;
            }
            const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
            const current = accelerators(id, overrides(settings));
            setOverride(settings, id, add.active
                ? [...current.filter(k => k !== accelerator), accelerator]
                : [accelerator]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(row);
    });
    return row;
}

function switchRow(settings: Gio.Settings, key: string, title: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A combo row for a string key with fixed choices: [value, title, subtitle]. */
function choiceRow(settings: Gio.Settings, key: string, title: string, choices: readonly (readonly [string, string, string])[]): Adw.ComboRow {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(c => c[1]))});
    const sync = () => {
        row.selected = Math.max(0, choices.findIndex(c => c[0] === settings.get_string(key)));
        row.subtitle = choices[row.selected][2];
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function spinRow(settings: Gio.Settings, key: string, title: string, subtitle: string, upper: number, step: number): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: 0, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** An entry for a binary that turns red if it can't be found. */
/** Edits rbw's own config (email, server); applied with `rbw config set`. */
function rbwConfigRow(settings: Gio.Settings, key: keyof RbwConfig, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, show_apply_button: true, sensitive: false});
    if (key === 'server')
        row.set_tooltip_text('Self-hosted or EU cloud, e.g. https://vault.example.com or https://vault.bitwarden.eu');
    rbwConfig(settings).then(config => {
        row.text = config[key];
        row.sensitive = true;
    }).catch(() => {});
    row.connect('apply', async () => {
        try {
            await setRbwConfig(settings, {[key]: row.text});
            row.text = (await rbwConfig(settings))[key];
            row.remove_css_class('error');
        } catch (e) {
            console.error('quick-launcher: Could not change the rbw config', e);
            row.add_css_class('error');
        }
    });
    return row;
}

function programRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    const check = () => {
        if (findProgram(settings.get_string(key)))
            row.remove_css_class('error');
        else
            row.add_css_class('error');
    };
    check();
    const id = settings.connect(`changed::${key}`, check);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

/** Shows a keyboard shortcut; click to record a new one. */
function shortcutRow(settings: Gio.Settings, key: string, title: string): Adw.ActionRow {
    const label = new Gtk.ShortcutLabel({
        disabled_text: 'Disabled',
        valign: Gtk.Align.CENTER,
    });
    const row = new Adw.ActionRow({title, activatable: true});
    row.add_suffix(label);

    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));

    row.connect('activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: 'Press a shortcut, Esc to cancel or Backspace to disable it.',
        });
        dialog.add_response('cancel', 'Cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval: number, keycode: number, state: Gdk.ModifierType) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return Gdk.EVENT_STOP;

            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(row);
    });
    return row;
}
