// Unit table for the calculator. Every unit is a factor to SI base units
// plus a dimension vector, so any two units with the same dimension convert.
// No GNOME imports: unit tested with Node.

/** Exponents of [length, mass, time, current, temperature, amount, luminosity, information, angle, currency] */
export type Dim = readonly number[];

export const DIMENSIONS = 10;
const [L, M, T, I, K, , J, B, A, C] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface Unit {
    /** Display symbol */
    symbol: string;
    factor: number;
    dim: Dim;
    /** For temperatures: base = (value + offset) * factor */
    offset?: number;
}

function dim(entries: Partial<Record<number, number>>): Dim {
    const d = new Array(DIMENSIONS).fill(0);
    for (const [index, exp] of Object.entries(entries))
        d[Number(index)] = exp;
    return d;
}

export const DIMENSIONLESS = dim({});
export const CURRENCY = dim({[C]: 1});

export function sameDim(a: Dim, b: Dim): boolean {
    return a.every((x, i) => x === b[i]);
}

export function inverseDim(a: Dim, b: Dim): boolean {
    return a.some(x => x !== 0) && a.every((x, i) => x === -b[i]);
}

export function mulDim(a: Dim, b: Dim, sign = 1): Dim {
    return a.map((x, i) => x + sign * b[i]);
}

export function powDim(a: Dim, n: number): Dim {
    return a.map(x => x * n);
}

const SI_PREFIXES: [string, string, number][] = [
    ['Q', 'quetta', 1e30], ['R', 'ronna', 1e27], ['Y', 'yotta', 1e24], ['Z', 'zetta', 1e21],
    ['E', 'exa', 1e18], ['P', 'peta', 1e15], ['T', 'tera', 1e12], ['G', 'giga', 1e9],
    ['M', 'mega', 1e6], ['k', 'kilo', 1e3], ['h', 'hecto', 1e2], ['da', 'deca', 1e1],
    ['d', 'deci', 1e-1], ['c', 'centi', 1e-2], ['m', 'milli', 1e-3], ['µ', 'micro', 1e-6],
    ['u', 'micro', 1e-6], ['n', 'nano', 1e-9], ['p', 'pico', 1e-12], ['f', 'femto', 1e-15],
    ['a', 'atto', 1e-18], ['z', 'zepto', 1e-21], ['y', 'yocto', 1e-24],
];
const BIG_PREFIXES = SI_PREFIXES.filter(([, , f]) => f >= 1e3);
const BINARY_PREFIXES: [string, string, number][] = [
    ['Ki', 'kibi', 2 ** 10], ['Mi', 'mebi', 2 ** 20], ['Gi', 'gibi', 2 ** 30],
    ['Ti', 'tebi', 2 ** 40], ['Pi', 'pebi', 2 ** 50], ['Ei', 'exbi', 2 ** 60],
];

type Prefixes = 'si' | 'big' | 'big+binary' | 'none';

interface Definition {
    symbols: string[];
    names?: string[];
    factor: number;
    dim: Dim;
    offset?: number;
    prefixes?: Prefixes;
}

const PX = 0.0254 / 96;

const DEFINITIONS: Definition[] = [
    // Length
    {symbols: ['m'], names: ['meter', 'metre'], factor: 1, dim: dim({[L]: 1}), prefixes: 'si'},
    {symbols: ['inch', '"', 'zoll'], names: ['inch', 'inches'], factor: 0.0254, dim: dim({[L]: 1})},
    {symbols: ['ft', "'"], names: ['foot', 'feet', 'fuß', 'fuss'], factor: 0.3048, dim: dim({[L]: 1})},
    {symbols: ['yd'], names: ['yard'], factor: 0.9144, dim: dim({[L]: 1})},
    {symbols: ['mi'], names: ['mile', 'meile', 'meilen'], factor: 1609.344, dim: dim({[L]: 1})},
    {symbols: ['nmi'], names: ['nauticalmile', 'seemeile', 'seemeilen'], factor: 1852, dim: dim({[L]: 1})},
    {symbols: ['au'], names: ['astronomicalunit'], factor: 1.495978707e11, dim: dim({[L]: 1})},
    {symbols: ['ly'], names: ['lightyear', 'lichtjahr', 'lichtjahre'], factor: 9.4607304725808e15, dim: dim({[L]: 1})},
    {symbols: ['pc'], names: ['parsec'], factor: 30856775814913670, dim: dim({[L]: 1}), prefixes: 'big'},
    {symbols: ['Å'], names: ['angstrom'], factor: 1e-10, dim: dim({[L]: 1})},
    {symbols: ['px'], names: ['pixel', 'pixels'], factor: PX, dim: dim({[L]: 1})},
    {symbols: ['pt'], names: ['point', 'points'], factor: 0.0254 / 72, dim: dim({[L]: 1})},
    {symbols: ['rem', 'em'], factor: 16 * PX, dim: dim({[L]: 1})},
    {symbols: ['mil', 'thou'], factor: 2.54e-5, dim: dim({[L]: 1})},
    {symbols: ['fathom'], factor: 1.8288, dim: dim({[L]: 1})},
    {symbols: ['furlong'], factor: 201.168, dim: dim({[L]: 1})},
    {symbols: ['league'], factor: 4828.032, dim: dim({[L]: 1})},

    // Area
    {symbols: ['ha'], names: ['hectare', 'hektar'], factor: 1e4, dim: dim({[L]: 2})},
    {symbols: ['are', 'ar'], factor: 100, dim: dim({[L]: 2})},
    {symbols: ['acre', 'ac'], names: ['acres'], factor: 4046.8564224, dim: dim({[L]: 2})},
    {symbols: ['qm', 'sqm'], names: ['quadratmeter'], factor: 1, dim: dim({[L]: 2})},
    {symbols: ['sqkm', 'qkm'], factor: 1e6, dim: dim({[L]: 2})},
    {symbols: ['sqft'], factor: 0.09290304, dim: dim({[L]: 2})},
    {symbols: ['sqin'], factor: 6.4516e-4, dim: dim({[L]: 2})},
    {symbols: ['sqmi'], factor: 2589988.110336, dim: dim({[L]: 2})},

    // Volume
    {symbols: ['l', 'L'], names: ['liter', 'litre'], factor: 1e-3, dim: dim({[L]: 3}), prefixes: 'si'},
    {symbols: ['cc', 'ccm'], factor: 1e-6, dim: dim({[L]: 3})},
    {symbols: ['gal'], names: ['gallon', 'gallone', 'gallonen'], factor: 3.785411784e-3, dim: dim({[L]: 3})},
    {symbols: ['impgal'], names: ['imperialgallon'], factor: 4.54609e-3, dim: dim({[L]: 3})},
    {symbols: ['qt'], names: ['quart'], factor: 9.46352946e-4, dim: dim({[L]: 3})},
    {symbols: ['pint'], names: ['pints'], factor: 4.73176473e-4, dim: dim({[L]: 3})},
    {symbols: ['cup'], names: ['cups', 'tasse', 'tassen'], factor: 2.365882365e-4, dim: dim({[L]: 3})},
    {symbols: ['floz', 'fl.oz'], names: ['fluidounce'], factor: 2.95735295625e-5, dim: dim({[L]: 3})},
    {symbols: ['tbsp', 'el'], names: ['tablespoon', 'esslöffel'], factor: 1.478676478125e-5, dim: dim({[L]: 3})},
    {symbols: ['tsp', 'tl'], names: ['teaspoon', 'teelöffel'], factor: 4.92892159375e-6, dim: dim({[L]: 3})},
    {symbols: ['bbl'], names: ['barrel'], factor: 0.158987294928, dim: dim({[L]: 3})},

    // Mass
    {symbols: ['g'], names: ['gram', 'gramm', 'gramme'], factor: 1e-3, dim: dim({[M]: 1}), prefixes: 'si'},
    {symbols: ['t'], names: ['tonne', 'tonnen', 'ton'], factor: 1000, dim: dim({[M]: 1}), prefixes: 'big'},
    {symbols: ['lb', 'lbs'], names: ['pound'], factor: 0.45359237, dim: dim({[M]: 1})},
    {symbols: ['oz'], names: ['ounce', 'unze', 'unzen'], factor: 0.028349523125, dim: dim({[M]: 1})},
    {symbols: ['st'], names: ['stone'], factor: 6.35029318, dim: dim({[M]: 1})},
    {symbols: ['ct'], names: ['carat', 'karat'], factor: 2e-4, dim: dim({[M]: 1})},
    {symbols: ['gr'], names: ['grain'], factor: 6.479891e-5, dim: dim({[M]: 1})},
    {symbols: ['pfund'], factor: 0.5, dim: dim({[M]: 1})},
    {symbols: ['zentner'], factor: 50, dim: dim({[M]: 1})},
    {symbols: ['shortton'], factor: 907.18474, dim: dim({[M]: 1})},
    {symbols: ['longton'], factor: 1016.0469088, dim: dim({[M]: 1})},

    // Time
    {symbols: ['s', 'sec'], names: ['second', 'sekunde', 'sekunden'], factor: 1, dim: dim({[T]: 1}), prefixes: 'si'},
    {symbols: ['min'], names: ['minute', 'minuten', 'mins'], factor: 60, dim: dim({[T]: 1})},
    {symbols: ['h', 'hr', 'std'], names: ['hour', 'stunde', 'stunden', 'hrs'], factor: 3600, dim: dim({[T]: 1})},
    {symbols: ['d'], names: ['day', 'tag', 'tage', 'tagen'], factor: 86400, dim: dim({[T]: 1})},
    {symbols: ['wk'], names: ['week', 'woche', 'wochen'], factor: 604800, dim: dim({[T]: 1})},
    {symbols: ['fortnight'], factor: 1209600, dim: dim({[T]: 1})},
    {symbols: ['mo'], names: ['month', 'monat', 'monate', 'monaten'], factor: 2629746, dim: dim({[T]: 1})},
    {symbols: ['yr', 'y', 'a'], names: ['year', 'jahr', 'jahre', 'jahren'], factor: 31556952, dim: dim({[T]: 1})},
    {symbols: ['decade'], names: ['jahrzehnt', 'jahrzehnte'], factor: 315569520, dim: dim({[T]: 1})},
    {symbols: ['century'], names: ['centuries', 'jahrhundert', 'jahrhunderte'], factor: 3155695200, dim: dim({[T]: 1})},
    {symbols: ['millennium'], names: ['millennia', 'jahrtausend'], factor: 31556952000, dim: dim({[T]: 1})},
    {symbols: ['workday'], names: ['arbeitstag', 'arbeitstage'], factor: 8 * 3600, dim: dim({[T]: 1})},
    {symbols: ['workweek'], names: ['arbeitswoche', 'arbeitswochen'], factor: 40 * 3600, dim: dim({[T]: 1})},

    // Speed
    {symbols: ['kph', 'kmh'], factor: 1000 / 3600, dim: dim({[L]: 1, [T]: -1})},
    {symbols: ['mph'], factor: 0.44704, dim: dim({[L]: 1, [T]: -1})},
    {symbols: ['kn', 'kt'], names: ['knot', 'knoten'], factor: 1852 / 3600, dim: dim({[L]: 1, [T]: -1})},
    {symbols: ['mach'], factor: 343, dim: dim({[L]: 1, [T]: -1})},
    {symbols: ['lightspeed'], names: ['speedoflight', 'lichtgeschwindigkeit'], factor: 299792458, dim: dim({[L]: 1, [T]: -1})},
    {symbols: ['mpg'], factor: 1609.344 / 3.785411784e-3, dim: dim({[L]: -2})},

    // Temperature
    {symbols: ['K'], names: ['kelvin'], factor: 1, dim: dim({[K]: 1})},
    {symbols: ['°C', 'C', 'degC'], names: ['celsius', 'grad'], factor: 1, offset: 273.15, dim: dim({[K]: 1})},
    {symbols: ['°F', 'F', 'degF'], names: ['fahrenheit'], factor: 5 / 9, offset: 459.67, dim: dim({[K]: 1})},
    {symbols: ['°R'], names: ['rankine'], factor: 5 / 9, dim: dim({[K]: 1})},

    // Information
    {symbols: ['bit', 'b'], names: ['bits'], factor: 1, dim: dim({[B]: 1}), prefixes: 'big+binary'},
    {symbols: ['B', 'byte'], names: ['bytes'], factor: 8, dim: dim({[B]: 1}), prefixes: 'big+binary'},

    // Energy, power, force, pressure
    {symbols: ['J'], names: ['joule'], factor: 1, dim: dim({[M]: 1, [L]: 2, [T]: -2}), prefixes: 'si'},
    {symbols: ['cal'], names: ['calorie', 'kalorie', 'kalorien'], factor: 4.184, dim: dim({[M]: 1, [L]: 2, [T]: -2}), prefixes: 'si'},
    {symbols: ['Wh'], factor: 3600, dim: dim({[M]: 1, [L]: 2, [T]: -2}), prefixes: 'si'},
    {symbols: ['eV'], factor: 1.602176634e-19, dim: dim({[M]: 1, [L]: 2, [T]: -2}), prefixes: 'si'},
    {symbols: ['BTU', 'btu'], factor: 1055.05585262, dim: dim({[M]: 1, [L]: 2, [T]: -2})},
    {symbols: ['erg'], factor: 1e-7, dim: dim({[M]: 1, [L]: 2, [T]: -2})},
    {symbols: ['therm'], factor: 1.05505585262e8, dim: dim({[M]: 1, [L]: 2, [T]: -2})},
    {symbols: ['W'], names: ['watt'], factor: 1, dim: dim({[M]: 1, [L]: 2, [T]: -3}), prefixes: 'si'},
    {symbols: ['hp'], names: ['horsepower'], factor: 745.69987158227, dim: dim({[M]: 1, [L]: 2, [T]: -3})},
    {symbols: ['PS'], names: ['pferdestärke', 'pferdestärken'], factor: 735.49875, dim: dim({[M]: 1, [L]: 2, [T]: -3})},
    {symbols: ['N'], names: ['newton'], factor: 1, dim: dim({[M]: 1, [L]: 1, [T]: -2}), prefixes: 'si'},
    {symbols: ['lbf'], factor: 4.4482216152605, dim: dim({[M]: 1, [L]: 1, [T]: -2})},
    {symbols: ['kgf', 'kp'], factor: 9.80665, dim: dim({[M]: 1, [L]: 1, [T]: -2})},
    {symbols: ['Pa'], names: ['pascal'], factor: 1, dim: dim({[M]: 1, [L]: -1, [T]: -2}), prefixes: 'si'},
    {symbols: ['bar'], factor: 1e5, dim: dim({[M]: 1, [L]: -1, [T]: -2}), prefixes: 'si'},
    {symbols: ['atm'], names: ['atmosphere'], factor: 101325, dim: dim({[M]: 1, [L]: -1, [T]: -2})},
    {symbols: ['psi'], factor: 6894.757293168, dim: dim({[M]: 1, [L]: -1, [T]: -2})},
    {symbols: ['mmHg'], factor: 133.322387415, dim: dim({[M]: 1, [L]: -1, [T]: -2})},
    {symbols: ['torr'], factor: 101325 / 760, dim: dim({[M]: 1, [L]: -1, [T]: -2})},

    // Frequency
    {symbols: ['Hz'], names: ['hertz'], factor: 1, dim: dim({[T]: -1}), prefixes: 'si'},
    {symbols: ['rpm'], factor: 1 / 60, dim: dim({[T]: -1})},
    {symbols: ['bpm'], factor: 1 / 60, dim: dim({[T]: -1})},

    // Electricity, light, amount
    {symbols: ['A'], names: ['ampere', 'amp', 'amps'], factor: 1, dim: dim({[I]: 1}), prefixes: 'si'},
    {symbols: ['V'], names: ['volt'], factor: 1, dim: dim({[M]: 1, [L]: 2, [T]: -3, [I]: -1}), prefixes: 'si'},
    {symbols: ['Ω', 'ohm'], names: ['ohms'], factor: 1, dim: dim({[M]: 1, [L]: 2, [T]: -3, [I]: -2}), prefixes: 'si'},
    {symbols: ['coulomb'], factor: 1, dim: dim({[I]: 1, [T]: 1})},
    {symbols: ['Ah'], factor: 3600, dim: dim({[I]: 1, [T]: 1}), prefixes: 'si'},
    {symbols: ['mol'], factor: 1, dim: dim({[5]: 1}), prefixes: 'si'},
    {symbols: ['cd'], names: ['candela'], factor: 1, dim: dim({[J]: 1})},

    // Angle
    {symbols: ['rad'], names: ['radian', 'radians'], factor: 1, dim: dim({[A]: 1}), prefixes: 'si'},
    {symbols: ['°', 'deg'], names: ['degree', 'degrees'], factor: Math.PI / 180, dim: dim({[A]: 1})},
    {symbols: ['gon'], factor: Math.PI / 200, dim: dim({[A]: 1})},
    {symbols: ['turn', 'rev'], names: ['turns', 'revolution', 'umdrehung', 'umdrehungen'], factor: 2 * Math.PI, dim: dim({[A]: 1})},
    {symbols: ['arcmin'], factor: Math.PI / 10800, dim: dim({[A]: 1})},
    {symbols: ['arcsec'], factor: Math.PI / 648000, dim: dim({[A]: 1})},

    // Plain multipliers
    {symbols: ['%'], names: ['percent', 'prozent'], factor: 0.01, dim: DIMENSIONLESS},
    {symbols: ['dozen'], names: ['dutzend'], factor: 12, dim: DIMENSIONLESS},
];

/** ECB reference currencies plus EUR; rates are supplied at evaluation time. */
export const CURRENCIES = [
    'EUR', 'USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK',
    'TRY', 'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP',
    'SGD', 'THB', 'ZAR',
];

export const CURRENCY_ALIASES: Record<string, string> = {
    '€': 'EUR', 'euro': 'EUR', 'euros': 'EUR',
    '$': 'USD', 'dollar': 'USD', 'dollars': 'USD', 'usd$': 'USD',
    '£': 'GBP', 'pound sterling': 'GBP', 'pfund sterling': 'GBP',
    '¥': 'JPY', 'yen': 'JPY',
    '₹': 'INR', 'rupee': 'INR', 'rupees': 'INR',
    'fr': 'CHF', 'franken': 'CHF', 'franc': 'CHF',
    '₩': 'KRW', 'won': 'KRW',
    'yuan': 'CNY', 'rmb': 'CNY', 'renminbi': 'CNY',
    '₺': 'TRY', 'lira': 'TRY',
    'zł': 'PLN', 'zloty': 'PLN',
    'kč': 'CZK', 'krone': 'DKK', 'kronen': 'DKK',
    'real': 'BRL', 'reais': 'BRL',
};

const exact = new Map<string, Unit>();
const folded = new Map<string, Unit>();

function add(name: string, unit: Unit, caseSensitive: boolean) {
    if (!exact.has(name))
        exact.set(name, unit);
    const key = name.toLowerCase();
    if (!caseSensitive && !folded.has(key))
        folded.set(key, unit);
}

for (const def of DEFINITIONS) {
    const base: Unit = {symbol: def.symbols[0], factor: def.factor, dim: def.dim, offset: def.offset};
    const names = def.names ?? [];
    for (const symbol of def.symbols)
        add(symbol, base, symbol.length === 1);
    for (const name of names)
        add(name, {...base}, false);

    const prefixes = def.prefixes === 'si' ? SI_PREFIXES
        : def.prefixes === 'big' ? BIG_PREFIXES
            : def.prefixes === 'big+binary' ? [...BIG_PREFIXES, ...BINARY_PREFIXES] : [];
    for (const [symbol, name, factor] of prefixes) {
        const prefixed = (s: string) => ({symbol: s, factor: def.factor * factor, dim: def.dim});
        for (const s of def.symbols.filter(x => /^[A-Za-zΩ]/.test(x)))
            add(`${symbol}${s}`, prefixed(`${symbol}${s}`), true);
        for (const n of [...names, ...def.symbols.filter(x => x.length > 2)])
            add(`${name}${n}`, prefixed(`${symbol}${def.symbols[0]}`), false);
    }
}

// Casual spellings that should win over the case-insensitive fallback.
for (const [alias, target] of Object.entries({
    kb: 'kB', mb: 'MB', gb: 'GB', tb: 'TB', pb: 'PB', kbit: 'kbit', mbit: 'Mbit', gbit: 'Gbit',
    kib: 'KiB', mib: 'MiB', gib: 'GiB', tib: 'TiB', kw: 'kW', kwh: 'kWh', mwh: 'MWh', khz: 'kHz',
    mhz: 'MHz', ghz: 'GHz', kj: 'kJ', kcal: 'kcal', hpa: 'hPa', kpa: 'kPa', mbar: 'mbar', ml: 'ml',
    cl: 'cl', dl: 'dl', c: '°C', f: '°F', '°c': '°C', '°f': '°F', kg: 'kg', mg: 'mg', km: 'km', cm: 'cm', mm: 'mm', ms: 'ms',
}))
    folded.set(alias, exact.get(target)!);

/** Finds a unit by name: exact, then case-insensitive, then without a plural "s". */
export function findUnit(name: string): Unit | null {
    return exact.get(name) ??
        folded.get(name.toLowerCase()) ??
        (/[^s]s$/i.test(name) ? folded.get(name.slice(0, -1).toLowerCase()) ?? null : null);
}

export function findCurrency(name: string): string | null {
    const upper = name.toUpperCase();
    if (CURRENCIES.includes(upper))
        return upper;
    return CURRENCY_ALIASES[name.toLowerCase()] ?? null;
}
