# Development

```sh
pnpm install
make check             # typecheck, lint, unit tests (node --test runs the .ts files directly, Node 24)
make install           # build into dist/ and copy to ~/.local/share/gnome-shell/extensions
make logs              # follow gnome-shell's journal
make screenshots       # re-render docs/*.png in a headless shell
make pack              # installable zip
```

On Wayland the shell cannot reload an extension in place, so log out and back in after
`make install`.

```
src/extension.ts        enable/disable, keybindings, wires the providers together
src/root.ts             the start view: recent items, commands, and the combined search
src/prefs.ts            Adwaita preferences, shortcut recorder, pinentry bridge installer
src/lib/launcher.ts     the popup: view stack, sections, pooled rows, footer, action panel, password prompt
src/lib/search.ts       Bitwarden-style token search (no GI imports, unit tested)
src/lib/shortcuts.ts    every in-launcher shortcut with its defaults, accelerator parsing (unit tested)
src/lib/output.ts       secret clipboard, virtual keyboard, timers
src/lib/subprocess.ts   Gio.Subprocess wrapper; secrets go over stdin, never argv
src/calc/               calculator: units, math, dates and time zones (pure, unit tested), ECB rates
src/passwords/          Vault interface, rbw and 1Password vaults, the D-Bus pinentry service
src/clockify/           API client, provider, task grouping and @project/#tag parsing
src/emoji/              emoji data (Emojibase, English + German) and search
src/system/             lock, suspend, power and desktop toggles
src/t3code/             active T3 Code sessions from its state database
src/bin/pinentry.ts     the pinentry program rbw runs when the bridge is on
tools/                  headless screenshot harness with fake rbw, op and Clockify
test/                   unit tests
```

TypeScript is compiled file by file with `tsc` (no bundler), so `dist/` mirrors `src/`. Types
come from [`@girs`](https://github.com/gjsify/ts-for-gir). Sources import each other with `.ts`
extensions; `rewriteRelativeImportExtensions` turns them into `.js` for GJS, and Node runs the
unit tests from the sources directly.

## Launcher, views and providers

`Launcher` (`src/lib/launcher.ts`) knows nothing about passwords or timers. It shows a stack of
`View`s; a view turns the query into `Section`s of `Item`s, and every item carries its `Action`s.
The first action runs on Enter and is named in the footer, the others have optional shortcuts and
are all listed in the action panel (Ctrl+K). Views can add actions that apply to every item, such
as *Sync Vaults* on Ctrl+R.

An action names its shortcut by id (`shortcut: 'copy-username'`), never by keys. The ids and their
default GTK accelerators are listed in `SHORTCUTS` in `src/lib/shortcuts.ts`, and so are the
launcher's own keys (Enter, Ctrl+K, moving the selection, Esc). The settings key
`launcher-shortcuts` (`a{sas}`) only stores what the user changed; an empty list turns a shortcut
off. The launcher reads it live, matches key presses against it and shows the current keys in the
footer and the action panel. The preferences build the *Shortcuts* page from the same list, so a
new action shortcut only needs an entry there.

Each feature is a provider with its own view (Passwords, Clockify, Emoji) plus a few methods
the start view uses: `search(query, limit)` for the combined results, `commands()`, and
`recent(id)` to turn an id from the *Recent* list back into an item. `Root` (`src/root.ts`) puts
it together: the calculator answer first, then a command whose name starts with the query, then
passwords, Clockify entries, the other commands and fallbacks. In the start view every word of
the query has to match, so `2 min in year` doesn't list everything containing "in".

`Onboarding` (`src/onboarding.ts`) is the *Getting Started* view. `Root.open()` pushes it on top
of the start view until the `onboarding-done` key is set, which happens when it is first shown;
`enable()` also posts a notification until then. Its rows read state the providers already
have: `Passwords.vaults()` (with `Vault.installed`, from the CLI on PATH), `Clockify.configured`
and `.error`, `T3Code.available`. *Connect* calls `Passwords.connect()`, which turns the vault
on, runs `Vault.setUp()` (rbw's account email and server, asked with the visible `Launcher.ask()`
prompt and written with `rbw config set`, followed by `rbw stop-agent` so the next unlock logs in
again),
installs the pinentry bridge for rbw, and unlocks. For Clockify, `ClockifyApi.verify()` checks
a key against `/user` before it is saved. A non-empty query is passed to the start view's search.

Styling comes from the shell theme. The window is a `.popup-menu-content`, rows are
`.popup-menu-item`s and the search field is a plain `StEntry`, so light and dark styles and the
accent color follow the system. Secondary text is dimmed with actor opacity instead of colors.
`stylesheet.css` only sets spacing and sizes, the colored command tiles and the vault logos. The
backdrop has a `Shell.BlurEffect` in background mode, which blurs the desktop behind the popup.

## Calculator

`src/calc/calculator.ts` tries `dates.ts` first and then `math.ts`. Both are pure TypeScript
using `Intl` (available in GJS and Node), so they are covered by `test/calc.test.ts`.

- `units.ts` defines every unit as a factor to SI base units plus a dimension vector (length,
  mass, time, current, temperature, amount, luminosity, information, angle, currency). Any two
  units with the same dimension convert, and inverse dimensions convert reciprocally (mpg ↔
  l/100km). SI and binary prefixes are generated. Temperatures carry an offset.
- `math.ts` is a recursive-descent parser over quantities: implicit multiplication (`2pi`),
  implicit addition of like units (`1h 30min`), percentages (`of`, `off`, `+ 20%`), functions,
  conversion with `in`/`to`/`as`/`nach`, bases and time spans. A plain number or a lone `5 km`
  is not an answer, so ordinary searches don't trigger it.
- `dates.ts` handles English and German date words, countdowns, calendar weeks, Unix timestamps
  and time zones. Places resolve through aliases (cities, countries, airports, abbreviations) and
  the city part of every IANA zone the runtime knows.
- `rates.ts` fetches the ECB reference rates at most twice a day and caches them.

## T3 Code

T3 Code keeps its state in SQLite (`~/.t3/userdata/statev2.sqlite`). `src/t3code/t3code.ts` runs
one query through `sqlite3 -readonly -json` (a few milliseconds on a multi-gigabyte database):
threads from `orchestration_v2_projection_threads` that aren't deleted or archived, whose
`settledOverride` isn't `settled` (the same rule T3 Code's sidebar uses) and that have no parent
thread (subagents), joined with the project title and the newest unfinished run from
`orchestration_v2_projection_runs` (`running`, `waiting`, …), whose `requested_at` is when the
current turn started. While the launcher is open the query repeats every two seconds.

The provider is only active when something handles `t3code://` links and the database exists.
Enter launches `t3code://threads/<environment-id>/<thread-id>` with that handler; the
environment id is in `~/.t3/userdata/environment-id`. T3 Code's desktop app turns such links into
its `/$environmentId/$threadId` route.

For screenshots, `tools/fixtures/t3code.sql` builds a small database with the same tables and a
fake `t3code.desktop` handler goes into the sandbox.

## Vaults

Both password managers implement `Vault` in `src/passwords/vault.ts`: `isUnlocked`, `unlock`,
`list`, `secret`, `sync` and `lock`. `list` returns metadata only. The launcher keeps it in
memory and searches it, and asks the vault for a password or TOTP code only when one is used.

`Passwords` (`src/passwords/passwords.ts`) opens the popup immediately with the items it already
has, then checks every enabled vault in parallel. Each vault reload carries a generation number,
so a slow answer that was overtaken by a newer one is dropped. A vault that is locked or failing
becomes a row of its own. Enter on that row calls `unlock` with a `Prompter`, which can either
turn the search field into a password field (`askSecret`) or hide the popup while another
program's prompt needs the keyboard (`stepAside`).

### 1Password

`op` runs as a subprocess for every call (`whoami`, `item list --format json`,
`item get --format json --reveal`, `item get --otp`). With desktop app integration, the app
manages the session and `op signin` shows its prompt. Otherwise the typed master password goes
to `op signin --raw` on stdin and the token it prints is passed back with `--session`. It lives
only in the extension's memory. An `op` error that means "signed out" turns the vault back into
an unlock row.

### Bitwarden and the pinentry bridge

rbw has no way to take the master password other than running a pinentry program, configured
with `rbw config set pinentry`. The bridge (`src/passwords/bridge.ts`), installed by the
preferences or by *Connect Bitwarden* into
`~/.local/share/quick-launcher/`, is:

- `pinentry`: a shell wrapper. If the extension answers `Ping` on
  `/de/falcondev/QuickLauncher/Pinentry` (on the shell's session bus name `org.gnome.Shell`), it
  runs `pinentry.js`, otherwise it `exec`s the previous pinentry.
- `pinentry.js` (from `src/bin/pinentry.ts`): speaks the Assuan protocol on stdin/stdout and
  forwards `GETPIN` to the extension's `GetPin` D-Bus method, which shows the password prompt in
  the launcher.

The D-Bus object is only exported while the setting is on. rbw reads its config on every
prompt, so switching takes effect without restarting the agent.

## Rows

Rows are created on first use and then reused: typing changes their labels instead of
destroying and rebuilding actors. At most 60 rows are shown. Once you move the selection, it
follows that item across background reloads; until then the first result stays selected.

## Screenshots

`tools/shoot.sh` re-runs itself on a private D-Bus session and starts a headless GNOME Shell on a
2800×1800 virtual monitor at scale 2, with a throwaway XDG home and the keyfile GSettings
backend, so the real desktop's dconf and session bus are untouched. It loads `dist/` and
`tools/driver`, a small helper extension that exposes a virtual keyboard and
`Shell.Screenshot.screenshot_area` over D-Bus. The script then drives the launcher like a user
and crops each shot to the popup plus a margin.

`rbw` and `op` are replaced by the scripts in `tools/fixtures`, which serve the JSON next to
them (the 1Password master password is `hunter2`). `tools/fixtures/clockify.py` is a fake
Clockify API on `127.0.0.1:8765`. The last scene resets everything and runs *Getting Started*:
it connects Bitwarden (email, then master password) and Clockify through the launcher.

```sh
make screenshots       # writes docs/*.png (QL_SCHEME=prefer-light for the light style)
```

## Releasing

1. Bump `version` in `package.json` and `version-name` in `src/metadata.json`, and increment
   `version` there.
2. Tag `vX.Y.Z` and attach `make pack`'s zip to a GitHub release.
3. In `packaging/`, set `pkgver` and run `updpkgsums`.
