import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export interface RunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

export interface RunOptions {
    /** Written to the process' stdin, e.g. a password; never put secrets in argv. */
    stdin?: string;
    /** Throw if the process exits unsuccessfully (default). */
    check?: boolean;
    cancellable?: Gio.Cancellable | null;
}

export class CommandError extends Error {
    readonly stderr: string;

    constructor(message: string, stderr = '') {
        super(message);
        this.name = 'CommandError';
        this.stderr = stderr;
    }
}

export async function run(argv: string[], {stdin, check = true, cancellable = null}: RunOptions = {}): Promise<RunResult> {
    let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    if (stdin !== undefined)
        flags |= Gio.SubprocessFlags.STDIN_PIPE;

    let proc: Gio.Subprocess;
    try {
        proc = Gio.Subprocess.new(argv, flags);
    } catch (e) {
        throw new CommandError(`Could not run ${argv[0]}: ${(e as Error).message}`);
    }

    const [stdout, stderr] = await proc.communicate_utf8_async(stdin ?? null, cancellable);
    const ok = proc.get_successful();
    if (check && !ok) {
        const message = stderr.trim().split('\n').at(-1) || `${GLib.path_get_basename(argv[0])} ${argv[1] ?? ''} failed`;
        throw new CommandError(message.trim(), stderr);
    }
    return {ok, stdout: stdout ?? '', stderr: stderr ?? ''};
}

/** Resolves a binary from settings: an absolute path, or a name looked up in PATH. */
export function findProgram(nameOrPath: string): string | null {
    if (nameOrPath.includes('/'))
        return GLib.file_test(nameOrPath, GLib.FileTest.IS_EXECUTABLE) ? nameOrPath : null;
    return GLib.find_program_in_path(nameOrPath);
}
