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
    assert.equal(show('days since 1.1.'), '284 days');
    assert.equal(show('easter'), 'Sunday, March 28, 2027');
    assert.equal(show('kw'), 'Week 42');
    assert.equal(evaluate('kw 1', context)?.expression.replace(/\s/g, ' '), 'Dec 29, 2025 – Jan 4, 2026');
    assert.equal(evaluate('1760000000', context)?.copy, '2025-10-09T08:53:20.000Z');
    assert.equal(show('unix'), '1791809820');
});

test('time zones', () => {
    assert.equal(show('time in tokyo'), '09:57 PM');
    assert.equal(show('zeit in new york'), '08:57 AM');
    assert.equal(show('5pm berlin in tokyo'), '12:00 AM');
    assert.equal(show('9am ny to berlin'), '03:00 PM');
    assert.equal(show('time in são paulo'), '09:57 AM');
    assert.equal(show('diff london'), '−1 h');
});
