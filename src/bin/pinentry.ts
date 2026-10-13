// A minimal pinentry (Assuan protocol) that forwards GETPIN to the Quick
// Launcher extension over D-Bus, so rbw's master password prompt shows up
// in the launcher. Run as `gjs -m pinentry.js` by the wrapper the
// preferences install; see prefs.ts.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

const BUS_NAME = 'org.gnome.Shell';
const OBJECT_PATH = '/de/falcondev/QuickLauncher/Pinentry';
const INTERFACE = 'de.falcondev.QuickLauncher.Pinentry';
const CANCELLED = 'ERR 83886179 Operation cancelled';

const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
const output = new GioUnix.OutputStream({fd: 1, close_fd: false});
const encoder = new TextEncoder();

function send(line: string) {
    output.write_all(encoder.encode(`${line}\n`), null);
    output.flush(null);
}

const decode = (text: string) => text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const encode = (text: string) => text.replace(/[%\r\n]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const request = {title: '', description: '', prompt: '', error: ''};

function getPin(): string | null {
    const reply = Gio.DBus.session.call_sync(BUS_NAME, OBJECT_PATH, INTERFACE, 'GetPin',
        new GLib.Variant('(ssss)', [request.title, request.description, request.prompt, request.error]),
        new GLib.VariantType('(bs)'), Gio.DBusCallFlags.NONE, 10 * 60 * 1000, null);
    const [ok, pin] = reply.deepUnpack() as [boolean, string];
    return ok ? pin : null;
}

send('OK Quick Launcher pinentry');
for (;;) {
    const [line] = input.read_line_utf8(null);
    if (line === null)
        break;

    const [command = '', ...rest] = line.split(' ');
    const arg = decode(rest.join(' '));
    switch (command.toUpperCase()) {
    case 'SETTITLE':
        request.title = arg;
        break;
    case 'SETDESC':
        request.description = arg;
        break;
    case 'SETPROMPT':
        request.prompt = arg.replace(/:\s*$/, '');
        break;
    case 'SETERROR':
        request.error = arg;
        break;
    case 'GETINFO':
        if (arg === 'pid')
            send(`D ${new Gio.Credentials().get_unix_pid()}`);
        break;
    case 'GETPIN': {
        let pin: string | null;
        try {
            pin = getPin();
        } catch (e) {
            send(`ERR 83886081 ${(e as Error).message.replace(/\n/g, ' ')}`);
            continue;
        }
        request.error = '';
        if (pin === null) {
            send(CANCELLED);
            continue;
        }
        send(`D ${encode(pin)}`);
        break;
    }
    case 'BYE':
        send('OK closing connection');
        output.close(null);
        System.exit(0);
    }
    send('OK');
}
