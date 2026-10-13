import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const PINENTRY_PATH = '/de/falcondev/QuickLauncher/Pinentry';

const INTERFACE = `
<node>
  <interface name="de.falcondev.QuickLauncher.Pinentry">
    <method name="Ping"/>
    <method name="GetPin">
      <arg type="s" direction="in" name="title"/>
      <arg type="s" direction="in" name="description"/>
      <arg type="s" direction="in" name="prompt"/>
      <arg type="s" direction="in" name="error"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="pin"/>
    </method>
  </interface>
</node>`;

export interface PinRequest {
    title: string;
    description: string;
    prompt: string;
    error: string;
}

/**
 * Answers password prompts from bin/pinentry.js (which rbw runs as its
 * pinentry) by asking in the launcher.
 */
export class PinentryService {
    readonly #ask: (request: PinRequest) => Promise<string | null>;
    readonly #object: Gio.DBusExportedObject;

    constructor(ask: (request: PinRequest) => Promise<string | null>) {
        this.#ask = ask;
        this.#object = Gio.DBusExportedObject.wrapJSObject(INTERFACE, {
            Ping: () => {},
            GetPinAsync: ([title, description, prompt, error]: string[], invocation: Gio.DBusMethodInvocation) =>
                this.#getPin({title, description, prompt, error}, invocation),
        });
        this.#object.export(Gio.DBus.session, PINENTRY_PATH);
    }

    async #getPin(request: PinRequest, invocation: Gio.DBusMethodInvocation) {
        try {
            const pin = await this.#ask(request);
            invocation.return_value(new GLib.Variant('(bs)', [pin !== null, pin ?? '']));
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', (e as Error).message);
        }
    }

    destroy() {
        this.#object.unexport();
    }
}
