/**
 * A Bitwarden server URL as rbw wants it: with a scheme, without a trailing
 * slash. Empty, "bitwarden.com" and its vault host mean the default server.
 */
export function normalizeServer(input: string): string {
    let url = input.trim().replace(/\/+$/, '');
    if (!url)
        return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url))
        url = `https://${url}`;
    if (/^https:\/\/(vault\.)?bitwarden\.com$/i.test(url))
        return '';
    return url;
}
