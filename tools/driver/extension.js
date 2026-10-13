// Loaded only by tools/shoot.sh into a throwaway headless shell. Exposes a
// virtual keyboard and stage screenshots on D-Bus (/qltest), so the script
// can drive the launcher like a user and capture it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');

/** The visible launcher popup, found by its style class. */
function findLauncher(actor) {
    if (!actor.visible)
        return null;
    if (actor.has_style_class_name?.('ql-box'))
        return actor;
    for (const child of actor.get_children()) {
        const found = findLauncher(child);
        if (found)
            return found;
    }
    return null;
}

const IFACE = `<node><interface name="qltest.Driver">
<method name="Keys"><arg type="as" direction="in"/></method>
<method name="Type"><arg type="s" direction="in"/></method>
<method name="Shot"><arg type="s" direction="in"/></method>
<method name="ShotLauncher"><arg type="s" direction="in"/><arg type="i" direction="in"/></method>
<method name="HideOverview"/>
</interface></node>`;

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

export default class Driver {
    enable() {
        this.kb = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const t = () => GLib.get_monotonic_time();
        this.obj = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            KeysAsync: async ([names], inv) => {
                const syms = names.map(n => Clutter[`KEY_${n}`]);
                for (const s of syms) { this.kb.notify_keyval(t(), s, Clutter.KeyState.PRESSED); await sleep(20); }
                for (const s of syms.reverse()) { this.kb.notify_keyval(t(), s, Clutter.KeyState.RELEASED); await sleep(20); }
                inv.return_value(null);
            },
            TypeAsync: async ([text], inv) => {
                for (const c of text) {
                    const s = Clutter.unicode_to_keysym(c.codePointAt(0));
                    this.kb.notify_keyval(t(), s, Clutter.KeyState.PRESSED);
                    this.kb.notify_keyval(t(), s, Clutter.KeyState.RELEASED);
                    await sleep(15);
                }
                inv.return_value(null);
            },
            ShotAsync: async ([path], inv) => {
                try {
                    const stream = Gio.File.new_for_path(path).replace(null, false, 0, null);
                    await new Shell.Screenshot().screenshot(false, stream);
                    stream.close(null);
                    inv.return_value(null);
                } catch (e) { inv.return_dbus_error('qltest.Error', String(e)); }
            },
            ShotLauncherAsync: async ([path, margin], inv) => {
                try {
                    const box = findLauncher(Main.layoutManager.uiGroup);
                    if (!box)
                        throw new Error('launcher is not open');
                    const [x, y] = box.get_transformed_position();
                    const [w, h] = box.get_transformed_size();
                    const stream = Gio.File.new_for_path(path).replace(null, false, 0, null);
                    await new Shell.Screenshot().screenshot_area(
                        Math.round(x - margin), Math.round(y - margin),
                        Math.round(w + 2 * margin), Math.round(h + 2 * margin), stream);
                    stream.close(null);
                    inv.return_value(null);
                } catch (e) { inv.return_dbus_error('qltest.Error', String(e)); }
            },
            HideOverview: () => Main.overview.hide(),
        });
        this.obj.export(Gio.DBus.session, '/qltest');
    }
    disable() { this.obj.unexport(); }
}
