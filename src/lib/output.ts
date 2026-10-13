import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLIPBOARD_INDICATOR_UUID = 'clipboard-indicator@tudmotu.com';
const MODIFIER_KEYS: Record<string, number | undefined> = {
    control: Clutter.KEY_Control_L, ctrl: Clutter.KEY_Control_L, primary: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L, alt: Clutter.KEY_Alt_L, super: Clutter.KEY_Super_L,
};

const HELD_MODIFIERS = Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.MOD4_MASK |
    Clutter.ModifierType.SUPER_MASK;

/** Timeouts that are cancelled together when the extension is disabled. */
export class Timers {
    readonly #ids = new Set<number>();

    add(ms: number, callback: () => void): number {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.#ids.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this.#ids.add(id);
        return id;
    }

    remove(id: number) {
        if (this.#ids.delete(id))
            GLib.source_remove(id);
    }

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => this.add(ms, resolve));
    }

    clear() {
        for (const id of this.#ids)
            GLib.source_remove(id);
        this.#ids.clear();
    }
}

/** Copies secrets and clears them again after a timeout. */
export class SecretClipboard {
    readonly #settings: Gio.Settings;
    readonly #timers: Timers;
    readonly #clipboard = St.Clipboard.get_default();
    #secret: string | null = null;
    #clearId = 0;

    constructor(settings: Gio.Settings, timers: Timers) {
        this.#settings = settings;
        this.#timers = timers;
    }

    copy(secret: string) {
        this.#timers.remove(this.#clearId);
        this.#clearId = 0;

        this.#secret = secret;
        this.#clipboard.set_text(St.ClipboardType.CLIPBOARD, secret);

        // Clipboard Indicator records the selection asynchronously.
        this.#timers.add(300, () => this.#scrubHistory(secret));
        this.#timers.add(1500, () => this.#scrubHistory(secret));

        const seconds = this.#settings.get_int('clear-clipboard-seconds');
        if (seconds > 0)
            this.#clearId = this.#timers.add(seconds * 1000, () => this.clear());
    }

    /** Clears the clipboard, but only if it still holds our secret. */
    clear() {
        const secret = this.#secret;
        this.#secret = null;
        if (secret === null)
            return;

        this.#clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (text === secret)
                this.#clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        });
        this.#scrubHistory(secret);
    }

    /** Clears synchronously; used on disable when callbacks may not run. */
    clearNow() {
        if (this.#secret !== null)
            this.#clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        this.#secret = null;
    }

    #scrubHistory(secret: string) {
        if (!this.#settings.get_boolean('scrub-clipboard-history'))
            return;

        // Clipboard Indicator has no API for this; poke at its internals defensively.
        const indicator = (Main.extensionManager.lookup(CLIPBOARD_INDICATOR_UUID) as any)
            ?.stateObj?.clipboardIndicator;
        const items = indicator?.clipItemsRadioGroup;
        if (!Array.isArray(items) || typeof indicator._removeEntry !== 'function')
            return;

        for (const item of [...items]) {
            if (item.entry?.getStringValue?.() === secret)
                indicator._removeEntry(item);
        }
    }
}

/** Types text into the focused window through a virtual keyboard. */
export class Typist {
    readonly #settings: Gio.Settings;
    readonly #timers: Timers;
    #device: Clutter.VirtualInputDevice | null = null;

    constructor(settings: Gio.Settings, timers: Timers) {
        this.#settings = settings;
        this.#timers = timers;
    }

    async type(text: string) {
        await this.#waitForModifierRelease();

        this.#device ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const delay = this.#settings.get_int('type-delay-ms');
        for (const char of text) {
            const keyval = char === '\t' ? Clutter.KEY_Tab
                : char === '\n' ? Clutter.KEY_Return
                    : Clutter.unicode_to_keysym(char.codePointAt(0)!);

            const time = GLib.get_monotonic_time();
            this.#device.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
            this.#device.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
            if (delay > 0)
                await this.#timers.sleep(delay);
        }
    }

    /** Presses a key combination such as `<Control><Shift>l`. */
    async press(accelerator: string) {
        await this.#waitForModifierRelease();
        const key = Clutter[`KEY_${accelerator.replace(/<\w+>/g, '').trim()}` as keyof typeof Clutter] as number | undefined;
        if (typeof key !== 'number')
            throw new Error(`Unknown key in ${accelerator}`);
        const modifiers = [...accelerator.matchAll(/<(\w+)>/g)].map(([, m]) => MODIFIER_KEYS[m.toLowerCase()]);
        if (modifiers.includes(undefined))
            throw new Error(`Unknown modifier in ${accelerator}`);

        this.#device ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const send = (keyval: number, state: Clutter.KeyState) =>
            this.#device!.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        for (const m of modifiers)
            send(m!, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.PRESSED);
        send(key, Clutter.KeyState.RELEASED);
        for (const m of modifiers.reverse())
            send(m!, Clutter.KeyState.RELEASED);
    }

    // The launcher is triggered by e.g. Ctrl+Enter; typing while Ctrl is
    // still held would send shortcuts instead of text. Also give the
    // previously focused window a moment to get focus back.
    async #waitForModifierRelease() {
        await this.#timers.sleep(80);
        for (let i = 0; i < 150; i++) {
            const [, , mods] = global.get_pointer();
            if ((mods & HELD_MODIFIERS) === 0)
                break;
            await this.#timers.sleep(20);
        }
        await this.#timers.sleep(40);
    }

    destroy() {
        this.#device = null;
    }
}

export function osd(icon: string, label: string) {
    Main.osdWindowManager.showOne(Main.layoutManager.currentMonitor?.index ?? 0,
        new Gio.ThemedIcon({name: icon}), label, null, undefined);
}

export function notifyError(message: string, error: unknown) {
    console.error(`quick-launcher: ${message}`, error);
    Main.notifyError(message, error instanceof Error ? error.message : String(error));
}
