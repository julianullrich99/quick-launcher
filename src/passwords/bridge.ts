import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {findProgram, run} from '../lib/subprocess.ts';

/**
 * rbw always asks through a pinentry program. This points it at a small
 * script that forwards the prompt to the launcher over D-Bus (falling back
 * to the previous pinentry when the extension isn't running), or restores
 * the previous pinentry.
 */
export async function setPinentryBridge(settings: Gio.Settings, enabled: boolean, extensionDir: Gio.File) {
    const rbw = settings.get_string('rbw-path') || 'rbw';
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'quick-launcher']);
    const wrapper = GLib.build_filenamev([dir, 'pinentry']);

    if (!enabled) {
        await run([rbw, 'config', 'set', 'pinentry', settings.get_string('rbw-pinentry-fallback') || 'pinentry']);
        settings.set_boolean('rbw-pinentry-bridge', false);
        return;
    }

    const {stdout} = await run([rbw, 'config', 'show'], {check: false});
    let current = 'pinentry';
    try {
        current = JSON.parse(stdout).pinentry || current;
    } catch {}
    if (current !== wrapper)
        settings.set_string('rbw-pinentry-fallback', current);

    const gjs = findProgram('gjs');
    const gdbus = findProgram('gdbus');
    if (!gjs || !gdbus)
        throw new Error('gjs and gdbus are needed for the bridge');

    GLib.mkdir_with_parents(dir, 0o700);
    const script = GLib.build_filenamev([dir, 'pinentry.js']);
    extensionDir.get_child('bin').get_child('pinentry.js')
        .copy(Gio.File.new_for_path(script), Gio.FileCopyFlags.OVERWRITE, null, null);

    const q = GLib.shell_quote;
    const fallback = settings.get_string('rbw-pinentry-fallback') || 'pinentry';
    const content = `#!/bin/sh
# Installed by the Quick Launcher GNOME extension: asks for rbw's master
# password in the launcher, or uses the regular pinentry if it isn't running.
if ${q(gdbus)} call --session --dest org.gnome.Shell \\
    --object-path /de/falcondev/QuickLauncher/Pinentry \\
    --method de.falcondev.QuickLauncher.Pinentry.Ping >/dev/null 2>&1; then
  exec ${q(gjs)} -m ${q(script)}
fi
exec ${q(fallback)} "$@"
`;
    GLib.file_set_contents(wrapper, content);
    GLib.chmod(wrapper, 0o755);

    await run([rbw, 'config', 'set', 'pinentry', wrapper]);
    settings.set_boolean('rbw-pinentry-bridge', true);
}
