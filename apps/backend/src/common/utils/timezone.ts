/** Return the UTC interval occupied by the current calendar day in `timeZone`. */
export function currentDayUtcRange(timeZone: string, now = new Date()) {
    const date = partsInTimeZone(now, timeZone);
    const start = localMidnightToUtc(date.year, date.month, date.day, timeZone);
    const nextDate = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    const end = localMidnightToUtc(
        nextDate.getUTCFullYear(),
        nextDate.getUTCMonth() + 1,
        nextDate.getUTCDate(),
        timeZone,
    );
    return { start, end };
}

function partsInTimeZone(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find(part => part.type === type)?.value);
    return {
        year: value('year'), month: value('month'), day: value('day'),
        hour: value('hour'), minute: value('minute'), second: value('second'),
    };
}

function offsetAt(instant: Date, timeZone: string) {
    const p = partsInTimeZone(instant, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
        - instant.getTime();
}

function localMidnightToUtc(year: number, month: number, day: number, timeZone: string) {
    const localAsUtc = Date.UTC(year, month - 1, day);
    let result = new Date(localAsUtc - offsetAt(new Date(localAsUtc), timeZone));
    // Re-evaluate at the resulting instant to handle a daylight-saving boundary.
    result = new Date(localAsUtc - offsetAt(result, timeZone));
    return result;
}
