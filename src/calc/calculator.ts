// Entry point of the calculator: dates and time zones first, then math with units.
import {evaluateDate, type DateContext} from './dates.ts';
import {calculate, type CalcContext, type CalcResult} from './math.ts';

export type {CalcResult};

export function evaluate(query: string, context: CalcContext & DateContext = {}): CalcResult | null {
    const text = query.trim();
    if (!text || text.length > 200)
        return null;
    try {
        return evaluateDate(text, context) ?? calculate(text, context);
    } catch {
        return null;
    }
}
