import assert from 'node:assert/strict';
import {test} from 'node:test';

import {evaluate} from '../src/calc/calculator.ts';

const now = new Date('2026-10-12T12:57:00Z');
const context = {
    locale: 'en-US',
    timeZone: 'Europe/Berlin',
    now,
    rates: {USD: 1.09, GBP: 0.85, JPY: 162},
    defaultCurrency: 'EUR',
};
const show = (query: string) => evaluate(query, context)?.display ?? null;

test('math', () => {
    assert.equal(show('2+3*4'), '14');
    assert.equal(show('(1+2)*3'), '9');
    assert.equal(show('2^10'), '1,024');
    assert.equal(show('2 power 10'), '1,024');
    assert.equal(show('sqrt(625)'), '25');
    assert.equal(show('square root of 625'), '25');
    assert.equal(show('10!'), '3,628,800');
    assert.equal(show('2pi'), '6.283185307');
    assert.equal(show('sin(30)'), '0.5');
    assert.equal(show('1,5 * 2'), '3');
    assert.equal(show('1.5k * 3'), '4,500');
    assert.equal(show('10 mod 3'), '1');
});

test('percentages', () => {
    assert.equal(show('52% of 900'), '468');
    assert.equal(show('7 % von 200'), '14');
    assert.equal(show('20% off 80'), '64');
    assert.equal(show('80 + 20%'), '96');
    assert.equal(show('80 - 25%'), '60');
});

test('units', () => {
    assert.equal(show('2 min in year'), '3.802649 × 10⁻⁶ yr');
    assert.equal(show('10ft in m'), '3.048 m');
    assert.equal(show('1h 30min in min'), '90 min');
    assert.equal(show('2 tage in stunden'), '48 h');
    assert.equal(show('145 min to timespan'), '2 h 25 min');
    assert.equal(show('28h / 5'), '5 h 36 min');
    assert.equal(show('100 h / 3'), '33 h 20 min');
    assert.equal(show('7 min / 2'), '3 min 30 s');
    assert.equal(show('10 h / 2'), '5 h');
    assert.equal(show('5,6h'), '5 h 36 min');
    assert.equal(show('5h'), null);
    assert.equal(show('90 min in h'), '1 h 30 min');
    assert.equal(show('1.5 wk'), '1 wk 3 d 12 h');
    assert.equal(show('2.5 years'), '2 yr 6 mo');
    assert.equal(show('3 km / 50 kmh'), '3 min 36 s');
    assert.equal(show('55h in workdays'), '6.875 workday');
    assert.equal(show('100 km/h in mph'), '62.13711922 mph');
    assert.equal(show('60 mph in km/h'), '96.56064 km/h');
    assert.equal(show('30 mpg in l/100km'), '7.840486111 l/100 km');
    assert.equal(show('1 m2 in cm2'), '10,000 cm²');
    assert.equal(show('1 GiB in MB'), '1,073.741824 MB');
    assert.equal(show('500 mb in gb'), '0.5 GB');
    assert.equal(show('32px in rem'), '2 rem');
    assert.equal(show('100 W * 3 h in kWh'), '0.3 kWh');
    assert.equal(show('3 km + 200 m'), '3.2 km');
    assert.equal(show('5 m * 3 m'), '15 m²');
});

test('temperatures', () => {
    assert.equal(show('20 c in f'), '68°F');
    assert.equal(show('100 °F in °C'), '37.77777778°C');
    assert.equal(show('0 K in C'), '-273.15°C');
});

test('bases', () => {
    assert.equal(show('255 in hex'), '0xff');
    assert.equal(show('0xff in bin'), '0b11111111');
    assert.equal(show('0b1010 in dec'), '10');
});

test('currencies', () => {
    assert.equal(show('100 usd in gbp'), '77.98 GBP');
    assert.equal(show('100 eur in usd'), '109.00 USD');
    assert.equal(show('100 usd'), '91.74 EUR');
    assert.equal(show('$50'), '45.87 EUR');
    // A plain number added to an amount is in the same currency.
    assert.equal(show('254 + 548 usd in eur'), show('802 usd in eur'));
    assert.equal(show('5 + 3 km in m'), '8,000 m');
    assert.equal(evaluate('100 usd in eur', {...context, rates: undefined}), null);
});

test('plain words and lone numbers are not calculations', () => {
    for (const query of ['github', '1password', '2fa', '42', '5 km', 'mon', 'do', 'aws console', ''])
        assert.equal(show(query), null, query);
});

test('dates', () => {
    assert.equal(show('today'), 'Monday, October 12, 2026');
    assert.equal(show('heute'), 'Monday, October 12, 2026');
    assert.equal(show('tomorrow'), 'Tuesday, October 13, 2026');
    assert.equal(show('monday in 3 weeks'), 'Monday, November 2, 2026');
    assert.equal(show('next friday'), 'Friday, October 16, 2026');
    assert.equal(show('in 3 weeks'), 'Monday, November 2, 2026');
    assert.equal(show('vor 2 wochen'), 'Monday, September 28, 2026');
    assert.equal(show('today + 10 days'), 'Thursday, October 22, 2026');
    assert.equal(show('days until 24.12.'), '73 days');
    assert.equal(show('days until christmas'), '74 days');
    assert.equal(show('weeks until christmas'), '10 weeks 4 days');
    assert.equal(show('months until christmas'), '2 months 13 days');
    assert.equal(show('days since 1.1.'), '284 days');
    assert.equal(show('easter'), 'Sunday, March 28, 2027');
    assert.equal(show('kw'), 'Week 42');
    assert.equal(evaluate('kw 1', context)?.expression.replace(/\s/g, ' '), 'Dec 29, 2025 – Jan 4, 2026');
    assert.equal(evaluate('1760000000', context)?.copy, '2025-10-09T08:53:20.000Z');
    assert.equal(show('unix'), '1791809820');
});

test('moving a time or date', () => {
    assert.equal(show('13:59 uhr - 20h'), '05:59 PM');
    assert.match(evaluate('13:59 uhr - 20h', context)?.expression ?? '', /yesterday/);
    assert.equal(show('current - 2 month'), 'Wednesday, August 12, 2026');
    assert.equal(show('jetzt - 2 monate'), 'Wednesday, August 12, 2026');
    assert.equal(show('in 3 hours'), '05:57 PM');
    assert.equal(show('in 2h 30min'), '05:27 PM');
    assert.equal(show('vor 20 min'), '02:37 PM');
    assert.equal(show('3 hours ago'), '11:57 AM');
    assert.equal(show('now + 1,5h'), '04:27 PM');
    assert.equal(show('13:59 + 2h - 15min'), '03:44 PM');
    assert.equal(show('morgen 9 uhr + 90 min'), '10:30 AM');
    assert.equal(show('5pm in 2 hours'), '07:00 PM');
    // Further away than a day shows the date too; day steps keep the clock time across DST
    assert.equal(show('13:00 + 14 days'), 'Mon, Oct 26, 01:00 PM');
    assert.equal(evaluate('24.12. 18:00 - 3h', context)?.copy, '2026-12-24 15:00');
    assert.equal(show('in 30 days'), 'Wednesday, November 11, 2026');
});

test('time between two moments', () => {
    assert.equal(show('17:30 - 9:15'), '8 h 15 min');
    assert.equal(show('9:00 bis 17:30'), '8 h 30 min');
    assert.equal(show('22:00 bis 6:00'), '8 h');
    assert.equal(show('jetzt - 9:15'), '5 h 42 min');
});

test('time zones', () => {
    assert.equal(show('time in tokyo'), '09:57 PM');
    assert.equal(show('zeit in new york'), '08:57 AM');
    assert.equal(show('5pm berlin in tokyo'), '12:00 AM');
    assert.equal(show('9am ny to berlin'), '03:00 PM');
    assert.equal(show('time in são paulo'), '09:57 AM');
    assert.equal(show('diff london'), '−1 h');
});
