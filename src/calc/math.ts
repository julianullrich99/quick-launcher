// Expression evaluator with units: "2 min in year", "20% off 80",
// "100 km/h in mph", "sqrt(2)^2", "0xff in bin", "100 usd in eur".
// No GNOME imports: unit tested with Node.
import {
    CURRENCY, DIMENSIONLESS, findCurrency, findUnit, inverseDim, mulDim, powDim, sameDim,
    type Dim, type Unit,
} from './units.ts';

export class CalcError extends Error {}

export interface CalcContext {
    /** Units of each currency per 1 EUR (ECB reference rates). */
    rates?: Record<string, number>;
    /** Currency to show a lone amount in, e.g. "100 usd" → EUR */
    defaultCurrency?: string;
    locale?: string;
}

export interface CalcResult {
    /** Formatted for display, e.g. "3,8 × 10⁻⁶ yr" */
    display: string;
    /** Formatted for the clipboard, without grouping */
    copy: string;
    /** How the input was understood, e.g. "2 min → yr" */
    expression: string;
}

interface Quantity {
    /** Value in SI base units (EUR for currencies) */
    value: number;
    dim: Dim;
    /** Unit to display the result in when no target is given */
    unit?: Unit;
    percent?: boolean;
    /** Something beyond a bare number was involved (operator, unit, function) */
    computed?: boolean;
}

type Token =
    | {type: 'num'; value: number; text: string}
    | {type: 'id'; value: string}
    | {type: 'op'; value: string};

const CONVERT = new Set(['in', 'to', 'as', 'into', 'nach', 'zu', 'als', '->', '→', '=']);
const WORD_OPERATORS: Record<string, string> = {
    power: '^', hoch: '^', times: '*', mal: '*', x: '*', plus: '+', minus: '-', durch: '/',
};
const SUPERSCRIPTS: Record<string, string> = {'²': '^2', '³': '^3', '¹': '^1', '⁴': '^4'};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
    sqrt: Math.sqrt, wurzel: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
    ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2, log10: Math.log10, exp: Math.exp,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    min: Math.min, max: Math.max,
    fact: factorial, factorial,
};
const TRIG: Record<string, (x: number) => number> = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    cot: x => 1 / Math.tan(x), sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x),
};
const INVERSE_TRIG: Record<string, (x: number) => number> = {
    asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
};
const CONSTANTS: Record<string, number> = {
    pi: Math.PI, 'π': Math.PI, tau: 2 * Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2,
};

function factorial(n: number): number {
    if (n < 0 || !Number.isInteger(n) || n > 170)
        return n > 170 ? Infinity : NaN;
    let r = 1;
    for (let i = 2; i <= n; i++)
        r *= i;
    return r;
}

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    const text = input.replace(/[²³¹⁴]/g, c => SUPERSCRIPTS[c]).replace(/\s+/g, ' ').trim();
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        let m: RegExpMatchArray | null;
        if (rest[0] === ' ') {
            i++;
        } else if ((m = rest.match(/^0x[0-9a-f]+|^0b[01]+|^0o[0-7]+/i))) {
            tokens.push({type: 'num', value: Number(m[0].toLowerCase()), text: m[0]});
            i += m[0].length;
        } else if ((m = rest.match(/^(\d+(?:[.,]\d+)?|[.,]\d+)(e[+-]?\d+)?([kK](?![a-zA-Z])|M(?![a-zA-Z]))?/))) {
            let value = Number(`${m[1].replace(',', '.')}${m[2] ?? ''}`);
            if (m[3])
                value *= m[3] === 'M' ? 1e6 : 1e3;
            tokens.push({type: 'num', value, text: m[0]});
            i += m[0].length;
        } else if ((m = rest.match(/^(->|→|\*\*|[-+*/×÷·^()!,%=])/))) {
            const op = {'×': '*', '·': '*', '÷': '/', '**': '^'}[m[0]] ?? m[0];
            tokens.push({type: 'op', value: op});
            i += m[0].length;
        } else if ((m = rest.match(/^(°[CFR]?|[€$£¥₹₩₺"']|[\p{L}µΩÅ_][\p{L}\p{N}µΩÅ_.]*)/u))) {
            const word = m[0].replace(/\.$/, '');
            const op = WORD_OPERATORS[word.toLowerCase()];
            tokens.push(op ? {type: 'op', value: op} : {type: 'id', value: word});
            i += m[0].replace(/\.$/, '').length || 1;
        } else {
            throw new CalcError(`Unexpected "${rest[0]}"`);
        }
    }
    return tokens;
}

class Parser {
    readonly #tokens: Token[];
    readonly #context: CalcContext;
    #pos = 0;

    constructor(tokens: Token[], context: CalcContext) {
        this.#tokens = tokens;
        this.#context = context;
    }

    get done() {
        return this.#pos >= this.#tokens.length;
    }

    #peek(offset = 0): Token | undefined {
        return this.#tokens[this.#pos + offset];
    }

    #isOp(value: string, offset = 0) {
        const t = this.#peek(offset);
        return t?.type === 'op' && t.value === value;
    }

    #isWord(...words: string[]) {
        const t = this.#peek();
        return t?.type === 'id' && words.includes(t.value.toLowerCase());
    }

    #expect(value: string) {
        if (!this.#isOp(value))
            throw new CalcError(`Expected "${value}"`);
        this.#pos++;
    }

    parse(): Quantity {
        const q = this.#sum();
        if (!this.done)
            throw new CalcError('Unexpected input');
        return q;
    }

    #sum(): Quantity {
        let left = this.#product();
        while (this.#isOp('+') || this.#isOp('-')) {
            const sign = (this.#tokens[this.#pos++] as {value: string}).value === '+' ? 1 : -1;
            const right = this.#product();
            left = right.percent && !left.percent
                ? {...left, value: left.value * (1 + sign * right.value), computed: true}
                : add(left, right, sign);
        }
        return left;
    }

    #product(): Quantity {
        let left = this.#power();
        for (;;) {
            if (this.#isOp('*')) {
                this.#pos++;
                left = multiply(left, this.#power());
            } else if (this.#isOp('/')) {
                this.#pos++;
                left = multiply(left, this.#power(), -1);
            } else if (this.#isWord('mod')) {
                this.#pos++;
                const right = this.#power();
                left = {...left, value: ((left.value % right.value) + right.value) % right.value, computed: true};
            } else if (this.#isWord('of', 'von') && left.percent) {
                this.#pos++;
                const base = this.#power();
                left = {...base, value: base.value * left.value, computed: true};
            } else if (this.#isWord('off') && left.percent) {
                this.#pos++;
                const base = this.#power();
                left = {...base, value: base.value * (1 - left.value), computed: true};
            } else if (this.#startsPrimary() && !this.#isConversion()) {
                // Implicit: "2pi", "3(4+5)", and "1h 30min" adds up.
                const right = this.#power();
                left = left.unit && right.unit && sameDim(left.dim, right.dim) && !left.percent
                    ? add(left, right, 1)
                    : multiply(left, right);
            } else {
                return left;
            }
        }
    }

    #power(): Quantity {
        const base = this.#unary();
        if (!this.#isOp('^'))
            return base;
        this.#pos++;
        const exponent = this.#power();
        if (!sameDim(exponent.dim, DIMENSIONLESS))
            throw new CalcError('Exponent must be a number');
        return {
            value: base.value ** exponent.value,
            dim: powDim(base.dim, exponent.value),
            computed: true,
        };
    }

    #unary(): Quantity {
        if (this.#isOp('-')) {
            this.#pos++;
            const q = this.#unary();
            return {...q, value: -q.value, computed: q.computed};
        }
        if (this.#isOp('+')) {
            this.#pos++;
            return this.#unary();
        }
        return this.#postfix();
    }

    #postfix(): Quantity {
        let q = this.#primary();
        for (;;) {
            if (this.#isOp('!')) {
                this.#pos++;
                q = {...q, value: factorial(q.value), computed: true};
            } else if (this.#isOp('%')) {
                this.#pos++;
                q = {...q, value: q.value / 100, percent: true, computed: true};
            } else if (q.dim === DIMENSIONLESS && !q.unit && this.#peekUnit()) {
                // "5 km", "100 usd", "20 °C"
                q = this.#applyUnit(q);
            } else {
                return q;
            }
        }
    }

    #startsPrimary(): boolean {
        const t = this.#peek();
        return !!t && (t.type === 'num' || t.type === 'id' || (t.type === 'op' && t.value === '('));
    }

    #isConversion(): boolean {
        const t = this.#peek();
        return !!t && (t.type === 'id' || t.type === 'op') && CONVERT.has(String(t.value).toLowerCase());
    }

    /** A unit (with optional ^n) at the current position, without consuming it. */
    #peekUnit(): {unit: Unit; length: number} | null {
        const t = this.#peek();
        if (t?.type !== 'id' || CONVERT.has(t.value.toLowerCase()) || ['of', 'von', 'off', 'mod'].includes(t.value.toLowerCase()))
            return null;
        // "sq ft", "fl oz", "cubic meter"
        const next = this.#peek(1);
        if (next?.type === 'id') {
            const pair = findUnit(`${t.value}${next.value}`);
            if (pair)
                return {unit: pair, length: 2};
        }
        const unit = this.#resolveUnit(t.value);
        if (unit)
            return {unit, length: 1};
        // "m2", "cm3"
        const power = t.value.match(/^(.+?)([23])$/);
        const base = power && findUnit(power[1]);
        if (base) {
            const n = Number(power[2]);
            return {unit: {symbol: `${base.symbol}${superscript(n)}`, factor: base.factor ** n, dim: powDim(base.dim, n)}, length: 1};
        }
        return null;
    }

    #resolveUnit(name: string): Unit | null {
        const code = findCurrency(name);
        if (code) {
            const rate = code === 'EUR' ? 1 : this.#context.rates?.[code];
            if (!rate)
                throw new CalcError('Exchange rates are not loaded yet');
            return {symbol: code, factor: 1 / rate, dim: CURRENCY};
        }
        return findUnit(name);
    }

    #applyUnit(q: Quantity): Quantity {
        const found = this.#peekUnit()!;
        this.#pos += found.length;
        let {unit} = found;
        // "m^2", "m2" written as m^2 after superscript replacement
        if (this.#isOp('^') && this.#peek(1)?.type === 'num') {
            const n = (this.#peek(1) as {value: number}).value;
            this.#pos += 2;
            unit = {symbol: `${unit.symbol}${superscript(n)}`, factor: unit.factor ** n, dim: powDim(unit.dim, n)};
        }
        const value = unit.offset !== undefined
            ? (q.value + unit.offset) * unit.factor
            : q.value * unit.factor;
        return {value, dim: unit.dim, unit, computed: q.computed};
    }

    #primary(): Quantity {
        const t = this.#peek();
        if (!t)
            throw new CalcError('Incomplete expression');

        if (t.type === 'num') {
            this.#pos++;
            return {value: t.value, dim: DIMENSIONLESS, computed: /^0[xbo]/i.test(t.text)};
        }
        if (t.type === 'op' && t.value === '(') {
            this.#pos++;
            const q = this.#sum();
            this.#expect(')');
            return q;
        }
        if (t.type !== 'id')
            throw new CalcError(`Unexpected "${t.value}"`);

        const name = t.value.toLowerCase();

        // Currency symbol in front: "$100", "€ 5"
        if (/^[€$£¥₹₩₺]$/.test(t.value) && this.#peek(1)?.type === 'num') {
            this.#pos++;
            const amount = this.#primary();
            const unit = this.#resolveUnit(t.value)!;
            return {value: amount.value * unit.factor, dim: unit.dim, unit, computed: amount.computed};
        }

        if (name in CONSTANTS) {
            this.#pos++;
            return {value: CONSTANTS[name], dim: DIMENSIONLESS, computed: true};
        }

        // "square root of 625"
        if (name === 'square' && this.#peek(1)?.type === 'id' && (this.#peek(1) as {value: string}).value === 'root') {
            this.#pos += 2;
            if (this.#isWord('of'))
                this.#pos++;
            return {value: Math.sqrt(this.#power().value), dim: DIMENSIONLESS, computed: true};
        }

        // "min" is a function before "(", otherwise minutes.
        const fn = FUNCTIONS[name] ?? TRIG[name] ?? INVERSE_TRIG[name];
        if (fn && (this.#isOp('(', 1) || !this.#peekUnit())) {
            this.#pos++;
            const args = this.#arguments();
            if (TRIG[name]) {
                // Plain numbers are degrees, like most calculators people use.
                const [x] = args;
                const radians = x.dim[8] === 1 ? x.value : x.value * Math.PI / 180;
                return {value: TRIG[name](radians), dim: DIMENSIONLESS, computed: true};
            }
            if (INVERSE_TRIG[name]) {
                const degree = findUnit('°')!;
                return {value: INVERSE_TRIG[name](args[0].value), dim: degree.dim, unit: degree, computed: true};
            }
            if (args.length === 1 && (name === 'sqrt' || name === 'wurzel' || name === 'cbrt')) {
                const root = name === 'cbrt' ? 3 : 2;
                return {value: fn(args[0].value), dim: powDim(args[0].dim, 1 / root), computed: true};
            }
            const first = args[0];
            if (['abs', 'round', 'floor', 'ceil', 'trunc', 'min', 'max'].includes(name))
                return {...first, value: fn(...args.map(a => a.value)), computed: true};
            return {value: fn(...args.map(a => a.value)), dim: DIMENSIONLESS, computed: true};
        }

        // A bare unit: "km/h", "per hour"
        const found = this.#peekUnit();
        if (found)
            return this.#applyUnit({value: 1, dim: DIMENSIONLESS});

        throw new CalcError(`Unknown "${t.value}"`);
    }

    #arguments(): Quantity[] {
        if (!this.#isOp('(')) {
            // "sqrt 16", "sin 30°"
            return [this.#power()];
        }
        this.#pos++;
        const args = [this.#sum()];
        while (this.#isOp(',')) {
            this.#pos++;
            args.push(this.#sum());
        }
        this.#expect(')');
        return args;
    }
}

function add(a: Quantity, b: Quantity, sign: number): Quantity {
    // A plain number takes the other side's unit: "254 + 548 yuan" is 802 yuan.
    a = adopt(a, b);
    b = adopt(b, a);
    if (!sameDim(a.dim, b.dim))
        throw new CalcError('Cannot add different kinds of units');
    return {value: a.value + sign * b.value, dim: a.dim, unit: a.unit ?? b.unit, computed: true};
}

function adopt(q: Quantity, other: Quantity): Quantity {
    if (q.unit || q.percent || !sameDim(q.dim, DIMENSIONLESS) || !other.unit || other.unit.offset !== undefined)
        return q;
    return {...q, value: q.value * other.unit.factor, dim: other.dim, unit: other.unit};
}

function multiply(a: Quantity, b: Quantity, sign = 1): Quantity {
    const value = sign === 1 ? a.value * b.value : a.value / b.value;
    const dim = mulDim(a.dim, b.dim, sign);
    // Keep a display unit when scaling a quantity by a plain number, and
    // compose one when combining two ("km/h", "kW·h").
    let unit: Unit | undefined;
    if (sameDim(b.dim, DIMENSIONLESS) && !b.unit)
        unit = a.unit;
    else if (sign === 1 && sameDim(a.dim, DIMENSIONLESS) && !a.unit)
        unit = b.unit;
    else if (a.unit && b.unit && a.unit.offset === undefined && b.unit.offset === undefined) {
        const symbol = sign === -1 ? `${a.unit.symbol}/${b.unit.symbol}`
            : a.unit.symbol === b.unit.symbol ? `${a.unit.symbol}²` : `${a.unit.symbol}·${b.unit.symbol}`;
        unit = {symbol, factor: sign === 1 ? a.unit.factor * b.unit.factor : a.unit.factor / b.unit.factor, dim};
    }
    return {value, dim, unit, computed: true};
}

function superscript(n: number): string {
    const map: Record<string, string> = {'-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'};
    return String(n).replace(/[-0-9]/g, c => map[c]);
}

const BASE_SYMBOLS = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'bit', 'rad', 'EUR'];

/** "m²", "m/s", "kg·m²/s²" for a result without a display unit */
function siSymbol(dim: Dim): string {
    const part = (sign: number) => dim
        .map((e, i) => [e * sign, BASE_SYMBOLS[i]] as const)
        .filter(([e]) => e > 0)
        .map(([e, s]) => e === 1 ? s : `${s}${superscript(e)}`)
        .join('·');
    const top = part(1);
    const bottom = part(-1);
    if (!bottom)
        return top;
    return `${top || '1'}/${bottom}`;
}

/** Splits "a in b" at the last top-level conversion keyword. */
function splitConversion(tokens: Token[]): [Token[], Token[] | null] {
    let depth = 0;
    for (let i = tokens.length - 1; i > 0; i--) {
        const t = tokens[i];
        if (t.type === 'op' && t.value === ')')
            depth++;
        else if (t.type === 'op' && t.value === '(')
            depth--;
        else if (depth === 0 && CONVERT.has(String(t.value).toLowerCase()) && i < tokens.length - 1)
            return [tokens.slice(0, i), tokens.slice(i + 1)];
    }
    return [tokens, null];
}

export function formatNumber(value: number, locale?: string, grouping = true): string {
    if (!Number.isFinite(value))
        return Number.isNaN(value) ? 'NaN' : value > 0 ? '∞' : '-∞';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) {
        if (!grouping)
            return String(Number(value.toPrecision(10)));
        const [mantissa, exponent] = value.toExponential(6).split('e');
        const m = new Intl.NumberFormat(locale, {maximumSignificantDigits: 7, useGrouping: false}).format(Number(mantissa));
        return `${m} × 10${superscript(Number(exponent))}`;
    }
    return new Intl.NumberFormat(locale, {maximumSignificantDigits: 10, useGrouping: grouping}).format(value);
}

const BASES: Record<string, [number, string]> = {
    hex: [16, '0x'], hexadecimal: [16, '0x'], bin: [2, '0b'], binary: [2, '0b'], oct: [8, '0o'], octal: [8, '0o'],
};

/** Evaluates a query; null if it isn't a calculation worth showing. */
export function calculate(query: string, context: CalcContext = {}): CalcResult | null {
    let tokens: Token[];
    try {
        tokens = tokenize(query);
    } catch {
        return null;
    }
    if (tokens.length === 0 || !tokens.some(t => t.type === 'num' || (t.type === 'id' && t.value.toLowerCase() in CONSTANTS)))
        return null;

    const locale = context.locale;
    const [left, right] = splitConversion(tokens);
    try {
        const q = new Parser(left, context).parse();
        const source = joinTokens(left);

        if (right) {
            const targetText = joinTokens(right);
            const base = BASES[targetText.toLowerCase()];
            if (base) {
                const n = Math.round(q.value);
                const text = `${n < 0 ? '-' : ''}${base[1]}${Math.abs(n).toString(base[0])}`;
                return {display: text, copy: text, expression: `${source} → ${targetText}`};
            }
            if (/^(dec|decimal)$/i.test(targetText)) {
                return {display: formatNumber(q.value, locale), copy: formatNumber(q.value, locale, false), expression: `${source} → ${targetText}`};
            }
            if (/^(timespan|hh:mm|duration|dauer)$/i.test(targetText) && q.dim[2] === 1)
                return timespan(q.value, `${source} → ${targetText}`);
            if (/^(%|percent|prozent)$/i.test(targetText) && sameDim(q.dim, DIMENSIONLESS))
                return result(q.value * 100, '%', `${source} → %`, locale);

            const target = new Parser(right, context).parse();
            const unit = target.unit;
            let value: number;
            if (unit?.offset !== undefined && sameDim(q.dim, target.dim)) {
                // Temperatures: "20 °C in °F"
                value = q.value / unit.factor - unit.offset;
            } else if (sameDim(q.dim, target.dim)) {
                value = q.value / target.value;
            } else if (inverseDim(q.dim, target.dim)) {
                // "30 mpg in l/100km"
                value = 1 / (q.value * target.value);
            } else {
                return null;
            }
            const symbol = right.length === 1 && target.unit ? target.unit.symbol : targetText;
            return result(value, symbol, `${source} → ${targetText}`, locale);
        }

        if (!q.computed && !q.unit)
            return null;

        // A lone amount of money is shown in the default currency.
        if (q.unit?.dim === CURRENCY) {
            const code = context.defaultCurrency ?? 'EUR';
            const rate = code === 'EUR' ? 1 : context.rates?.[code];
            if (!rate || q.unit.symbol === code)
                return q.computed && !isLoneAmount(left) ? result(q.value / q.unit.factor, q.unit.symbol, source, locale) : null;
            return result(q.value * rate, code, `${source} → ${code}`, locale);
        }
        if (isLoneAmount(left))
            return null;

        if (q.percent)
            return result(q.value * 100, '%', source, locale);
        if (q.unit && sameDim(q.unit.dim, q.dim)) {
            const value = q.unit.offset !== undefined ? q.value / q.unit.factor - q.unit.offset : q.value / q.unit.factor;
            return result(value, q.unit.symbol, source, locale);
        }
        return result(q.value, sameDim(q.dim, DIMENSIONLESS) ? '' : siSymbol(q.dim), source, locale);
    } catch {
        return null;
    }
}

/** "5 km" alone is not a calculation. */
function isLoneAmount(tokens: Token[]): boolean {
    const [first, ...rest] = tokens;
    return first?.type === 'num' && rest.length <= 2 && rest.every(t => t.type === 'id' && !(t.value.toLowerCase() in CONSTANTS));
}

function tokenText(t: Token): string {
    return t.type === 'num' ? t.text : String(t.value);
}

/** "l / 100 km" → "l/100 km", "m ^ 2" → "m²" */
function joinTokens(tokens: Token[]): string {
    let text = '';
    tokens.forEach((t, i) => {
        const prev = tokens[i - 1];
        const tight = !prev ||
            (t.type === 'op' && ['/', '^', ')', '!', '%', ','].includes(t.value)) ||
            (prev.type === 'op' && ['/', '^', '('].includes(prev.value)) ||
            (prev.type === 'id' && /^[€$£¥₹₩₺]$/.test(prev.value));
        text += `${tight ? '' : ' '}${tokenText(t)}`;
    });
    return text.replace(/\^(-?\d+)/g, (_, n: string) => superscript(Number(n)));
}

function result(value: number, symbol: string, expression: string, locale?: string): CalcResult {
    const space = symbol && !/^[%°]/.test(symbol) ? ' ' : '';
    if (/^[A-Z]{3}$/.test(symbol) && findCurrency(symbol)) {
        const money = (grouping: boolean) => new Intl.NumberFormat(locale, {
            minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: grouping,
        }).format(value);
        return {display: `${money(true)} ${symbol}`, copy: money(false), expression};
    }
    return {
        display: `${formatNumber(value, locale)}${space}${symbol}`,
        copy: formatNumber(value, locale, false),
        expression,
    };
}

function timespan(seconds: number, expression: string): CalcResult {
    const total = Math.round(Math.abs(seconds));
    const d = Math.floor(total / 86400);
    const h = Math.floor(total % 86400 / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = total % 60;
    const parts = [d && `${d} d`, h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean);
    const text = `${seconds < 0 ? '-' : ''}${parts.join(' ') || '0 s'}`;
    return {display: text, copy: text, expression};
}
