import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Installed as extension.js by `make reload`. GNOME Shell imports an extension
// once per session, so this imports the real one from a new directory on every
// enable; disabling and enabling then runs the latest build.
export default class DevLoader extends Extension {
    #real = null;
    #loading = null;

    enable() {
        const [, bytes] = this.dir.get_child('live').get_child('current').load_contents(null);
        const version = new TextDecoder().decode(bytes).trim();
        const loading = import(`./live/${version}/extension.js`).then(({default: Real}) => {
            if (this.#loading !== loading)
                return;
            this.#real = new Real(this.metadata);
            this.#real.enable();
        }).catch(e => console.error('quick-launcher: Could not load the dev build', e));
        this.#loading = loading;
    }

    disable() {
        this.#loading = null;
        this.#real?.disable();
        this.#real = null;
    }
}
