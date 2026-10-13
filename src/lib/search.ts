// Search modelled after the Bitwarden clients (libs/common search.service):
// every whitespace-separated token is matched as a substring ("*token*")
// against an item's weighted fields. Items matching more tokens rank first,
// then by score, then in their original order.

/** A searchable field: its weight and one or more values. */
export type Field = [weight: number, value: string | readonly string[] | undefined];

interface Indexed<T> {
    item: T;
    fields: [number, string[]][];
}

export function normalize(text: string | undefined): string {
    return (text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
}

/** Normalizes field values once, so each keystroke only does substring matching. */
export class SearchIndex<T> {
    readonly items: readonly T[];
    readonly #indexed: Indexed<T>[];

    constructor(items: readonly T[], fieldsOf: (item: T) => Field[]) {
        this.items = items;
        this.#indexed = items.map(item => ({
            item,
            fields: fieldsOf(item).map(([weight, values]) =>
                [weight, [values ?? []].flat().filter(Boolean).map(normalize)]),
        }));
    }

    /** With `all`, only items matching every word ("2 min in year" shouldn't find "Infra"). */
    search(query: string, {all = false} = {}): T[] {
        const tokens = normalize(query).split(/\s+/).filter(Boolean);
        if (tokens.length === 0)
            return this.items.slice();

        return this.#indexed
            .map((entry, index) => ({index, item: entry.item, ...score(entry, tokens)}))
            .filter(r => all ? r.matched === tokens.length : r.matched > 0)
            .sort((a, b) =>
                b.matched - a.matched ||
                b.score - a.score ||
                a.index - b.index)
            .map(r => r.item);
    }
}

function score(entry: Indexed<unknown>, tokens: string[]) {
    let matched = 0;
    let total = 0;

    for (const token of tokens) {
        let tokenScore = 0;
        for (const [weight, values] of entry.fields)
            tokenScore += weight * Math.max(0, ...values.map(v => fieldScore(v, token)));

        if (tokenScore > 0) {
            matched++;
            total += tokenScore;
        }
    }
    return {matched, score: total};
}

function fieldScore(value: string, token: string): number {
    const index = value.indexOf(token);
    if (index < 0)
        return 0;

    let result = 1;
    if (value === token)
        result += 2;
    else if (index === 0)
        result += 1;
    else if (/[^\p{L}\p{N}]/u.test(value[index - 1]))
        result += 0.5;

    // Shorter fields with a match are more relevant (like BM25 length norm).
    return result * (1 + token.length / value.length);
}
