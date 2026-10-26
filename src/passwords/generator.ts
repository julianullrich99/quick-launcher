export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const SYMBOLS = '!@#$%^&*-_=+?';

/** A random string with at least one character from every class, if it is long enough. */
export function generate(length: number, classes: readonly string[], randomBytes: (count: number) => Uint8Array): string {
    const alphabet = classes.join('');
    for (;;) {
        const password = Array.from({length}, () => alphabet[uniform(alphabet.length, randomBytes)]).join('');
        if (length < classes.length || classes.every(c => [...c].some(char => password.includes(char))))
            return password;
    }
}

/** An unbiased random number below `n` (at most 256): bytes past the last whole multiple of `n` are rejected. */
function uniform(n: number, randomBytes: (count: number) => Uint8Array): number {
    const limit = 256 - 256 % n;
    for (;;) {
        const [byte] = randomBytes(1);
        if (byte < limit)
            return byte % n;
    }
}
