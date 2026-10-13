// Date and time queries: "today", "monday in 3 weeks", "days until 24.12.",
// "kw", "1760000000", "time in tokyo", "5pm berlin in new york".
// English and German keywords. No GNOME imports: unit tested with Node.
import type {CalcResult} from './math.ts';

export interface DateContext {
    now?: Date;
    locale?: string;
    /** IANA zone of the user; defaults to the system zone */
    timeZone?: string;
}

const DAY = 86_400_000;

const WEEKDAYS: Record<string, number> = {
    sunday: 0, sun: 0, sonntag: 0, so: 0,
    monday: 1, mon: 1, montag: 1, mo: 1,
    tuesday: 2, tue: 2, tues: 2, dienstag: 2, di: 2,
    wednesday: 3, wed: 3, mittwoch: 3, mi: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4, donnerstag: 4, do: 4,
    friday: 5, fri: 5, freitag: 5, fr: 5,
    saturday: 6, sat: 6, samstag: 6, sonnabend: 6, sa: 6,
};

const MONTHS: Record<string, number> = {
    january: 0, jan: 0, januar: 0, jänner: 0,
    february: 1, feb: 1, februar: 1,
    march: 2, mar: 2, märz: 2, maerz: 2, mär: 2,
    april: 3, apr: 3,
    may: 4, mai: 4,
    june: 5, jun: 5, juni: 5,
    july: 6, jul: 6, juli: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, oktober: 9, okt: 9,
    november: 10, nov: 10,
    december: 11, dec: 11, dezember: 11, dez: 11,
};

const UNITS: Record<string, 'day' | 'week' | 'month' | 'year' | 'hour' | 'minute'> = {
    d: 'day', day: 'day', days: 'day', tag: 'day', tage: 'day', tagen: 'day',
    w: 'week', wk: 'week', week: 'week', weeks: 'week', woche: 'week', wochen: 'week',
    mo: 'month', month: 'month', months: 'month', monat: 'month', monate: 'month', monaten: 'month',
    y: 'year', yr: 'year', year: 'year', years: 'year', jahr: 'year', jahre: 'year', jahren: 'year',
    h: 'hour', hour: 'hour', hours: 'hour', stunde: 'hour', stunden: 'hour',
    min: 'minute', minute: 'minute', minutes: 'minute', minuten: 'minute',
};

/** Place names that aren't the city part of an IANA zone. */
const PLACE_ALIASES: Record<string, string> = {
    'utc': 'UTC', 'gmt': 'UTC', 'zulu': 'UTC',
    'ny': 'America/New_York', 'nyc': 'America/New_York', 'new york city': 'America/New_York',
    'est': 'America/New_York', 'edt': 'America/New_York', 'et': 'America/New_York', 'boston': 'America/New_York',
    'washington': 'America/New_York', 'miami': 'America/New_York', 'atlanta': 'America/New_York',
    'sf': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', 'la': 'America/Los_Angeles',
    'seattle': 'America/Los_Angeles', 'pst': 'America/Los_Angeles', 'pdt': 'America/Los_Angeles',
    'pt': 'America/Los_Angeles', 'silicon valley': 'America/Los_Angeles', 'san jose': 'America/Los_Angeles',
    'cst': 'America/Chicago', 'cdt': 'America/Chicago', 'austin': 'America/Chicago', 'dallas': 'America/Chicago',
    'mst': 'America/Denver', 'mdt': 'America/Denver',
    'ldn': 'Europe/London', 'uk': 'Europe/London', 'england': 'Europe/London', 'bst': 'Europe/London',
    'cet': 'Europe/Berlin', 'cest': 'Europe/Berlin', 'mez': 'Europe/Berlin', 'mesz': 'Europe/Berlin',
    'germany': 'Europe/Berlin', 'deutschland': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'münchen': 'Europe/Berlin',
    'hamburg': 'Europe/Berlin', 'köln': 'Europe/Berlin', 'cologne': 'Europe/Berlin', 'frankfurt': 'Europe/Berlin',
    'stuttgart': 'Europe/Berlin', 'düsseldorf': 'Europe/Berlin', 'leipzig': 'Europe/Berlin', 'dresden': 'Europe/Berlin',
    'nürnberg': 'Europe/Berlin', 'hannover': 'Europe/Berlin', 'bremen': 'Europe/Berlin',
    'wien': 'Europe/Vienna', 'österreich': 'Europe/Vienna', 'austria': 'Europe/Vienna',
    'zürich': 'Europe/Zurich', 'zurich': 'Europe/Zurich', 'genf': 'Europe/Zurich', 'geneva': 'Europe/Zurich',
    'schweiz': 'Europe/Zurich', 'switzerland': 'Europe/Zurich', 'bern': 'Europe/Zurich',
    'france': 'Europe/Paris', 'frankreich': 'Europe/Paris', 'rom': 'Europe/Rome', 'italy': 'Europe/Rome',
    'italien': 'Europe/Rome', 'mailand': 'Europe/Rome', 'milan': 'Europe/Rome', 'spain': 'Europe/Madrid',
    'spanien': 'Europe/Madrid', 'barcelona': 'Europe/Madrid', 'lissabon': 'Europe/Lisbon',
    'warschau': 'Europe/Warsaw', 'prag': 'Europe/Prague', 'moskau': 'Europe/Moscow', 'athen': 'Europe/Athens',
    'kopenhagen': 'Europe/Copenhagen', 'brüssel': 'Europe/Brussels', 'den haag': 'Europe/Amsterdam',
    'netherlands': 'Europe/Amsterdam', 'niederlande': 'Europe/Amsterdam', 'ireland': 'Europe/Dublin',
    'ist': 'Asia/Kolkata', 'india': 'Asia/Kolkata', 'indien': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata',
    'delhi': 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata', 'bengaluru': 'Asia/Kolkata',
    'jst': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', 'tokio': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo',
    'china': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai', 'peking': 'Asia/Shanghai', 'shenzhen': 'Asia/Shanghai',
    'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul', 'südkorea': 'Asia/Seoul',
    'peking time': 'Asia/Shanghai', 'hongkong': 'Asia/Hong_Kong', 'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai',
    'israel': 'Asia/Jerusalem', 'tel aviv': 'Asia/Jerusalem', 'türkei': 'Europe/Istanbul', 'turkey': 'Europe/Istanbul',
    'aest': 'Australia/Sydney', 'australia': 'Australia/Sydney', 'australien': 'Australia/Sydney',
    'canberra': 'Australia/Sydney', 'nz': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
    'neuseeland': 'Pacific/Auckland', 'wellington': 'Pacific/Auckland',
    'brasilien': 'America/Sao_Paulo', 'brazil': 'America/Sao_Paulo', 'rio': 'America/Sao_Paulo',
    'rio de janeiro': 'America/Sao_Paulo', 'mexiko': 'America/Mexico_City', 'mexico': 'America/Mexico_City',
    'kanada': 'America/Toronto', 'canada': 'America/Toronto', 'montreal': 'America/Toronto',
    'kapstadt': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg', 'kairo': 'Africa/Cairo',
    'singapur': 'Asia/Singapore', 'hawaii': 'Pacific/Honolulu', 'alaska': 'America/Anchorage',
    'jfk': 'America/New_York', 'lax': 'America/Los_Angeles', 'sfo': 'America/Los_Angeles', 'lhr': 'Europe/London',
    'fra': 'Europe/Berlin', 'muc': 'Europe/Berlin', 'ber': 'Europe/Berlin', 'cdg': 'Europe/Paris',
    'hnd': 'Asia/Tokyo', 'nrt': 'Asia/Tokyo', 'dxb': 'Asia/Dubai', 'sin': 'Asia/Singapore',
};

let zonesByCity: Map<string, string> | null = null;

/** "tokyo" → Asia/Tokyo, from the IANA names the runtime knows plus aliases. */
export function findZone(place: string): string | null {
    const key = place.trim().toLowerCase().replace(/\s+/g, ' ');
    const plain = key.normalize('NFKD').replace(/\p{M}/gu, '');
    if (!key)
        return null;
    if (PLACE_ALIASES[key] ?? PLACE_ALIASES[plain])
        return PLACE_ALIASES[key] ?? PLACE_ALIASES[plain];
    if (!zonesByCity) {
        zonesByCity = new Map();
        for (const zone of Intl.supportedValuesOf('timeZone')) {
            const city = zone.split('/').at(-1)!.replace(/_/g, ' ').toLowerCase();
            if (!zonesByCity.has(city))
                zonesByCity.set(city, zone);
        }
    }
    return zonesByCity.get(key) ?? zonesByCity.get(plain) ?? (key.includes('/') ? Intl.supportedValuesOf('timeZone').find(z => z.toLowerCase() === key) ?? null : null);
}

function placeName(zone: string): string {
    return zone === 'UTC' ? 'UTC' : zone.split('/').at(-1)!.replace(/_/g, ' ');
}

/** Minutes the zone is ahead of UTC at `instant`. */
function zoneOffset(instant: number, zone: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The instant of a wall-clock time in a zone. */
function instantIn(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
    const guess = Date.UTC(y, mo, d, h, mi);
    let instant = guess - zoneOffset(guess, zone) * 60_000;
    instant = guess - zoneOffset(instant, zone) * 60_000;
    return instant;
}

function wallClock(instant: number, zone: string) {
    const shifted = new Date(instant + zoneOffset(instant, zone) * 60_000);
    return {y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate(), h: shifted.getUTCHours(), mi: shifted.getUTCMinutes()};
}

function offsetLabel(minutes: number): string {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(minutes);
    return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

function hoursLabel(minutes: number): string {
    const h = minutes / 60;
    return `${h > 0 ? '+' : h < 0 ? '−' : '±'}${Math.abs(h).toLocaleString('en-US', {maximumFractionDigits: 2})} h`;
}

// --- Calendar dates (local, as day numbers to avoid DST surprises) ---

interface Day {
    y: number;
    m: number;
    d: number;
}

const toUtc = ({y, m, d}: Day) => Date.UTC(y, m, d);
const fromUtc = (ms: number): Day => {
    const date = new Date(ms);
    return {y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate()};
};
const addDays = (day: Day, n: number) => fromUtc(toUtc(day) + n * DAY);
const weekday = (day: Day) => new Date(toUtc(day)).getUTCDay();
const daysBetween = (a: Day, b: Day) => Math.round((toUtc(b) - toUtc(a)) / DAY);

function addMonths(day: Day, n: number): Day {
    const total = day.y * 12 + day.m + n;
    const y = Math.floor(total / 12);
    const m = total - y * 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return {y, m, d: Math.min(day.d, last)};
}

function isoWeek(day: Day): {week: number; year: number} {
    const thursday = addDays(day, 3 - ((weekday(day) + 6) % 7));
    const firstThursday = addDays({y: thursday.y, m: 0, d: 4}, 3 - ((weekday({y: thursday.y, m: 0, d: 4}) + 6) % 7));
    return {week: 1 + Math.round(daysBetween(firstThursday, thursday) / 7), year: thursday.y};
}

function easter(y: number): Day {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
    return {y, m: month, d: ((h + l - 7 * m + 114) % 31) + 1};
}

const HOLIDAYS: Record<string, (y: number) => Day> = {
    'christmas': y => ({y, m: 11, d: 25}), 'xmas': y => ({y, m: 11, d: 25}),
    'christmas eve': y => ({y, m: 11, d: 24}), 'weihnachten': y => ({y, m: 11, d: 24}),
    'heiligabend': y => ({y, m: 11, d: 24}),
    'new year': y => ({y, m: 0, d: 1}), 'new years': y => ({y, m: 0, d: 1}), 'neujahr': y => ({y, m: 0, d: 1}),
    'new years eve': y => ({y, m: 11, d: 31}), 'silvester': y => ({y, m: 11, d: 31}),
    'easter': easter, 'ostern': easter,
    'halloween': y => ({y, m: 9, d: 31}),
    'valentines day': y => ({y, m: 1, d: 14}), 'valentinstag': y => ({y, m: 1, d: 14}),
    'tag der deutschen einheit': y => ({y, m: 9, d: 3}),
    'end of year': y => ({y, m: 11, d: 31}), 'jahresende': y => ({y, m: 11, d: 31}),
};

class DateParser {
    readonly today: Day;
    #past = false;

    constructor(today: Day) {
        this.today = today;
    }

    /** A calendar date from text, or null. Dates without a year are the next occurrence. */
    date(input: string, past = false): Day | null {
        this.#past = past;
        const text = input.trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
        const t = this.today;
        const simple: Record<string, number> = {
            today: 0, heute: 0, tomorrow: 1, morgen: 1, yesterday: -1, gestern: -1,
            übermorgen: 2, uebermorgen: 2, vorgestern: -2, 'day after tomorrow': 2, 'day before yesterday': -2,
        };
        if (text in simple)
            return addDays(t, simple[text]);

        // "monday", "next friday", "nächsten freitag", "last monday"
        // Abbreviations ("mo", "fri") only with a qualifier, so typing "mon…" isn't a date.
        let m = text.match(/^(?:(next|nächste[nrs]?|naechste[nrs]?|kommende[nrs]?|this|diese[nrs]?|last|letzte[nrs]?)\s+)?([a-zäöü]+)$/);
        if (m && m[2] in WEEKDAYS && (m[1] || m[2].length > 3)) {
            const target = WEEKDAYS[m[2]];
            const which = m[1] ?? '';
            let diff = (target - weekday(t) + 7) % 7;
            if (/^(last|letzte)/.test(which))
                diff = diff === 0 ? -7 : diff - 7;
            else if (/^(next|nächste|naechste|kommende)/.test(which) && diff === 0)
                diff = 7;
            return addDays(t, diff);
        }

        if (text.startsWith('end of month') || text === 'monatsende')
            return fromUtc(Date.UTC(t.y, t.m + 1, 0));
        for (const [name, make] of Object.entries(HOLIDAYS)) {
            if (text === name || text === `${name} ${t.y}` || text.match(new RegExp(`^${name} (\\d{4})$`))) {
                const year = Number(text.match(/(\d{4})$/)?.[1] ?? NaN);
                if (!Number.isNaN(year))
                    return make(year);
                const thisYear = make(t.y);
                if (this.#past)
                    return daysBetween(t, thisYear) <= 0 ? thisYear : make(t.y - 1);
                return daysBetween(t, thisYear) >= 0 ? thisYear : make(t.y + 1);
            }
        }

        // 2026-12-24
        m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m)
            return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        // 24.12.2026, 24.12.26, 24.12., 24.12
        m = text.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/);
        if (m)
            return this.#withYear(Number(m[1]), Number(m[2]) - 1, m[3]);
        // 24 dec, 24. dezember 2026, dec 24, december 24 2026
        m = text.match(/^(\d{1,2})\.? ?([a-zäöü]+)\.?,? ?(\d{4})?$/);
        if (m && m[2] in MONTHS)
            return this.#withYear(Number(m[1]), MONTHS[m[2]], m[3]);
        m = text.match(/^([a-zäöü]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?$/);
        if (m && m[1] in MONTHS)
            return this.#withYear(Number(m[2]), MONTHS[m[1]], m[3]);
        return null;
    }

    #withYear(d: number, m: number, year?: string): Day | null {
        if (year)
            return valid(year.length === 2 ? 2000 + Number(year) : Number(year), m, d);
        const thisYear = valid(this.today.y, m, d);
        if (!thisYear)
            return null;
        if (this.#past)
            return daysBetween(this.today, thisYear) <= 0 ? thisYear : valid(this.today.y - 1, m, d);
        return daysBetween(this.today, thisYear) >= 0 ? thisYear : valid(this.today.y + 1, m, d);
    }
}

function valid(y: number, m: number, d: number): Day | null {
    if (m < 0 || m > 11 || d < 1 || d > 31)
        return null;
    const day = fromUtc(Date.UTC(y, m, d));
    return day.m === m ? day : null;
}

function shift(day: Day, n: number, unit: string): Day {
    switch (UNITS[unit]) {
    case 'day': return addDays(day, n);
    case 'week': return addDays(day, 7 * n);
    case 'month': return addMonths(day, n);
    case 'year': return addMonths(day, 12 * n);
    default: return day;
    }
}

/** Evaluates a date or time query; null if it isn't one. */
export function evaluateDate(query: string, context: DateContext = {}): CalcResult | null {
    const now = context.now ?? new Date();
    const zone = context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = context.locale;
    const text = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text)
        return null;

    const wall = wallClock(now.getTime(), zone);
    const today: Day = {y: wall.y, m: wall.mo, d: wall.d};
    const dates = new DateParser(today);

    const fmtDay = (day: Day, style: 'long' | 'short' = 'long') => new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC', weekday: style, day: 'numeric', month: style, year: 'numeric',
    }).format(new Date(toUtc(day)));
    const isoDay = (day: Day) => `${day.y}-${String(day.m + 1).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
    const fmtTime = (instant: number, tz: string) => new Intl.DateTimeFormat(locale, {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
    }).format(new Date(instant));
    const relative = (n: number) => new Intl.RelativeTimeFormat(locale, {numeric: 'auto'}).format(n, 'day');
    const dayResult = (day: Day, expression: string): CalcResult => {
        const diff = daysBetween(today, day);
        return {
            display: fmtDay(day),
            copy: isoDay(day),
            expression: [expression, diff !== 0 && relative(diff) !== expression && relative(diff), weekLabel(isoWeek(day).week)].filter(Boolean).join(' · '),
        };
    };
    const weekLabel = (week: number) => (locale ?? '').startsWith('de') ? `KW ${week}` : `Week ${week}`;

    // now / time / date
    if (/^(now|jetzt)$/.test(text)) {
        const display = new Intl.DateTimeFormat(locale, {dateStyle: 'full', timeStyle: 'short', timeZone: zone}).format(now);
        return {display, copy: now.toISOString(), expression: `${text} · ${placeName(zone)}`};
    }
    if (/^(time|zeit|uhrzeit|current time)$/.test(text))
        return {display: fmtTime(now.getTime(), zone), copy: fmtTime(now.getTime(), zone), expression: `${text} · ${placeName(zone)} (${offsetLabel(zoneOffset(now.getTime(), zone))})`};
    if (/^(date|datum)$/.test(text))
        return dayResult(today, text);

    // Unix timestamps
    if (/^(unix|timestamp|epoch|unix time|unixzeit)$/.test(text)) {
        const seconds = String(Math.floor(now.getTime() / 1000));
        return {display: seconds, copy: seconds, expression: 'Unix timestamp now'};
    }
    let m = text.match(/^(\d{10}|\d{13})$/);
    if (m) {
        const ms = m[1].length === 10 ? Number(m[1]) * 1000 : Number(m[1]);
        const display = new Intl.DateTimeFormat(locale, {dateStyle: 'full', timeStyle: 'medium', timeZone: zone}).format(new Date(ms));
        return {display, copy: new Date(ms).toISOString(), expression: `Unix ${m[1].length === 10 ? 'seconds' : 'milliseconds'} → ${placeName(zone)}`};
    }
    if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?$/.test(text)) {
        const date = new Date(query.trim());
        if (!Number.isNaN(date.getTime())) {
            const display = new Intl.DateTimeFormat(locale, {dateStyle: 'full', timeStyle: 'medium', timeZone: zone}).format(date);
            return {display, copy: String(Math.floor(date.getTime() / 1000)), expression: `${query.trim()} → ${placeName(zone)}`};
        }
    }

    // Calendar week: "kw", "kw 42", "week 42"
    m = text.match(/^(?:kw|calendar week|week|woche|kalenderwoche|cw)(?: (\d{1,2}))?(?: (\d{4}))?$/);
    if (m) {
        const year = m[2] ? Number(m[2]) : isoWeek(today).year;
        const week = m[1] ? Number(m[1]) : isoWeek(today).week;
        const jan4 = {y: year, m: 0, d: 4};
        const monday = addDays(addDays(jan4, -((weekday(jan4) + 6) % 7)), (week - 1) * 7);
        const sunday = addDays(monday, 6);
        const range = new Intl.DateTimeFormat(locale, {timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric'})
            .formatRange(new Date(toUtc(monday)), new Date(toUtc(sunday)));
        return {display: `${weekLabel(week)}`, copy: String(week), expression: range};
    }

    // Countdown: "days until 24.12.", "tage bis weihnachten", "weeks until easter", "days since 1.1."
    m = text.match(/^(?:how many )?(days|weeks|months|hours|tage|wochen|monate|stunden)? ?(until|till|to|bis|since|seit) (.+)$/);
    if (m && (m[1] || /^(until|till|bis|since|seit)$/.test(m[2]))) {
        const target = dates.date(m[3], /^(since|seit)$/.test(m[2]));
        if (target) {
            let days = daysBetween(today, target);
            if (/^(since|seit)$/.test(m[2]))
                days = -days;
            const unit = UNITS[m[1] ?? 'days'] ?? 'day';
            const value = unit === 'week' ? days / 7 : unit === 'month' ? days / 30.436875
                : unit === 'hour' ? Math.round((instantIn(zone, target.y, target.m, target.d, 0, 0) - now.getTime()) / 3_600_000) * (days < 0 ? -1 : 1) : days;
            const label = new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(value);
            const unitName = {day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], hour: ['hour', 'hours'], year: ['year', 'years'], minute: ['minute', 'minutes']}[unit];
            const german = (locale ?? '').startsWith('de');
            const names = german ? {day: ['Tag', 'Tage'], week: ['Woche', 'Wochen'], month: ['Monat', 'Monate'], hour: ['Stunde', 'Stunden'], year: ['Jahr', 'Jahre'], minute: ['Minute', 'Minuten']}[unit] : unitName;
            return {
                display: `${label} ${value === 1 ? names[0] : names[1]}`,
                copy: String(Number(value.toFixed(1))),
                expression: fmtDay(target),
            };
        }
    }

    // Date arithmetic: "in 3 weeks", "3 days ago", "vor 2 wochen", "monday in 3 weeks", "today + 10 days", "24.12. - 3 weeks"
    m = text.match(/^in (\d+) ([a-zä]+)$/);
    if (m && UNITS[m[2]] && UNITS[m[2]] !== 'hour' && UNITS[m[2]] !== 'minute')
        return dayResult(shift(today, Number(m[1]), m[2]), text);
    m = text.match(/^(?:(\d+) ([a-zä]+) ago|vor (\d+) ([a-zä]+))$/);
    if (m) {
        const n = Number(m[1] ?? m[3]);
        const unit = m[2] ?? m[4];
        if (UNITS[unit] && UNITS[unit] !== 'hour' && UNITS[unit] !== 'minute')
            return dayResult(shift(today, -n, unit), text);
    }
    m = text.match(/^(.+?) in (\d+) ([a-zä]+)$/);
    if (m && UNITS[m[3]] && !findZone(m[1])) {
        const base = dates.date(m[1]);
        if (base)
            return dayResult(shift(base, Number(m[2]), m[3]), text);
    }
    m = text.match(/^(.+?) ?([+-]) ?(\d+) ?([a-zä]+)$/);
    if (m && UNITS[m[4]] && UNITS[m[4]] !== 'hour' && UNITS[m[4]] !== 'minute') {
        const base = dates.date(m[1]);
        if (base)
            return dayResult(shift(base, (m[2] === '-' ? -1 : 1) * Number(m[3]), m[4]), text);
    }
    m = text.match(/^(.+?) - (.+)$/);
    if (m) {
        const a = dates.date(m[1]);
        const b = dates.date(m[2]);
        if (a && b) {
            const days = daysBetween(b, a);
            return {display: `${days} ${(locale ?? '').startsWith('de') ? (Math.abs(days) === 1 ? 'Tag' : 'Tage') : (Math.abs(days) === 1 ? 'day' : 'days')}`, copy: String(days), expression: `${fmtDay(b, 'short')} → ${fmtDay(a, 'short')}`};
        }
    }

    // A plain date: "today", "next friday", "24.12.", "easter"
    const day = dates.date(text);
    if (day && !/^\d{1,2}$/.test(text))
        return dayResult(day, text);

    return evaluateTimeZone(text, now, zone, locale);
}

const TIME = /(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|uhr|h)?/;

function parseTime(text: string): {h: number; mi: number} | null {
    const m = text.match(new RegExp(`^${TIME.source}$`));
    if (!m || (!m[2] && !m[3]))
        return null;
    let h = Number(m[1]);
    const mi = Number(m[2] ?? 0);
    if (m[3] === 'pm' && h < 12)
        h += 12;
    if (m[3] === 'am' && h === 12)
        h = 0;
    return h < 24 && mi < 60 ? {h, mi} : null;
}

function evaluateTimeZone(text: string, now: Date, local: string, locale?: string): CalcResult | null {
    const fmt = (instant: number, zone: string) => new Intl.DateTimeFormat(locale, {timeZone: zone, hour: '2-digit', minute: '2-digit'}).format(new Date(instant));
    const fmtDayShort = (instant: number, zone: string) => new Intl.DateTimeFormat(locale, {timeZone: zone, weekday: 'short', day: 'numeric', month: 'short'}).format(new Date(instant));
    const describe = (instant: number, zone: string) => {
        const offset = zoneOffset(instant, zone);
        const diff = offset - zoneOffset(instant, local);
        return `${placeName(zone)} · ${offsetLabel(offset)} · ${hoursLabel(diff)} · ${fmtDayShort(instant, zone)}`;
    };

    // "time in tokyo", "zeit in new york", "tokyo time", "uhrzeit tokyo"
    let m = text.match(/^(?:what time is it in |current time in |time in |zeit in |uhrzeit in |uhrzeit |wie spät ist es in )(.+)$/) ??
        text.match(/^(.+?) (?:time|zeit|uhrzeit)$/);
    if (m) {
        const zone = findZone(m[1]);
        if (zone) {
            const t = fmt(now.getTime(), zone);
            return {display: t, copy: t, expression: describe(now.getTime(), zone)};
        }
    }

    // "diff london", "time diff tokyo", "zeitunterschied tokyo"
    m = text.match(/^(?:time ?diff(?:erence)?|diff|zeitunterschied|zeitverschiebung) (?:to |zu |nach )?(.+)$/);
    if (m) {
        const zone = findZone(m[1]);
        if (zone) {
            const diff = zoneOffset(now.getTime(), zone) - zoneOffset(now.getTime(), local);
            return {display: hoursLabel(diff), copy: String(diff / 60), expression: `${placeName(zone)} vs. ${placeName(local)} · ${fmt(now.getTime(), zone)} there`};
        }
    }

    // "5pm berlin in tokyo", "15:00 in new york", "9am ny to berlin"
    m = text.match(/^(.+?) (?:in|to|nach|→|->) (.+)$/);
    if (m) {
        const to = findZone(m[2]);
        if (!to)
            return null;
        const left = m[1].trim();
        let time = parseTime(left);
        let from = local;
        if (!time) {
            const split = left.match(new RegExp(`^(${TIME.source}) (.+)$`));
            if (!split)
                return null;
            time = parseTime(split[1]);
            const zone = findZone(split[split.length - 1]);
            if (!time || !zone)
                return null;
            from = zone;
        }
        const wall = wallClock(now.getTime(), from);
        const instant = instantIn(from, wall.y, wall.mo, wall.d, time.h, time.mi);
        const t = fmt(instant, to);
        return {
            display: t,
            copy: t,
            expression: `${fmt(instant, from)} ${placeName(from)} → ${describe(instant, to)}`,
        };
    }
    return null;
}
