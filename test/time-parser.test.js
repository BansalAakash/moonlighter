import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, calculateWaitMs } from '../src/time-parser.js';

describe('parseResetTime', () => {
  it('parses "resets 3pm (Europe/Dublin)"', () => {
    const r = parseResetTime('5-hour limit reached - resets 3pm (Europe/Dublin)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Europe/Dublin');
  });
  it('parses "resets at 2pm (America/New_York)"', () => {
    const r = parseResetTime('Usage limit. Resets at 2pm (America/New_York)');
    assert.equal(r.hour, 14); assert.equal(r.timezone, 'America/New_York');
  });
  it('parses "resets 15:30 (Asia/Kolkata)"', () => {
    const r = parseResetTime('resets 15:30 (Asia/Kolkata)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 30);
  });
  it('parses 12pm as noon', () => {
    const r = parseResetTime('resets 12pm (UTC)');
    assert.equal(r.hour, 12);
  });
  it('parses 12am as midnight', () => {
    const r = parseResetTime('resets 12am (UTC)');
    assert.equal(r.hour, 0);
  });
  it('handles no timezone', () => {
    const r = parseResetTime('resets 3pm');
    assert.equal(r.hour, 15); assert.equal(r.timezone, null);
  });
  it('returns null for unparseable text', () => {
    assert.equal(parseResetTime('some random text'), null);
  });
  // Fable review F6: an out-of-range clock ("resets 30") must not parse a bad hour that
  // later makes calculateWaitMs build an Invalid Date and throw (crashing the monitor).
  it('returns null for an out-of-range hour ("resets 30")', () => {
    assert.equal(parseResetTime('resets 30'), null);
  });
  it('parses a 24h-style "resets 12:30" without an am/pm as ambiguous noon/midnight', () => {
    const r = parseResetTime('resets 12:30');
    assert.equal(r.hour, 12); assert.equal(r.minute, 30); assert.equal(r.ambiguous, true);
  });
  it('parses "try again in 5 minutes" as relative time', () => {
    const r = parseResetTime('try again in 5 minutes');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 5 * 60_000);
  });
  it('parses "try again in 2 hours" as relative time', () => {
    const r = parseResetTime('try again in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
  it('parses "wait 30 mins" as relative time', () => {
    const r = parseResetTime('wait 30 mins');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 30 * 60_000);
  });
  it('parses "resets in: 3 hours" as relative time', () => {
    const r = parseResetTime('usage limit · resets in: 3 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 3 * 3_600_000);
  });
  it('parses "resets in 2 hours" as relative time', () => {
    const r = parseResetTime('resets in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
});

describe('calculateWaitMs', () => {
  it('returns positive wait for future time', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 2) % 24;
    const wait = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 60, 5, now);
    assert.ok(wait > 0);
    assert.ok(wait <= 3 * 3600_000);
  });
  it('adds margin seconds', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 1) % 24;
    const w0 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 0, 5, now);
    const w120 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 120, 5, now);
    assert.ok(w120 - w0 >= 119_000 && w120 - w0 <= 121_000);
  });
  it('returns fallback when parsed is null', () => {
    const wait = calculateWaitMs(null, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000);
  });
  // Fable review F6: an ambiguous hour of 12 → the pm interpretation is (12+12)%24 = 0
  // (midnight), NOT hour 24 (which makes `new Date("…T24:…Z")` Invalid → throw → monitor
  // crash-loop). Must return a finite wait, never throw.
  it('does not throw on an ambiguous 12:30 (12+12 → midnight, not hour 24)', () => {
    const now = new Date('2026-07-07T09:00:00Z');
    const wait = calculateWaitMs({ hour: 12, minute: 30, timezone: 'UTC', ambiguous: true }, 60, 5, now);
    assert.ok(Number.isFinite(wait) && wait > 0);
  });
  it('handles ambiguous hour by picking soonest future', () => {
    const now = new Date('2026-03-18T13:00:00Z');
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now
    );
    assert.ok(wait > 0 && wait <= 3 * 3600_000);
  });
  // Ambiguous, BOTH interpretations past & outside grace: roll to the EARLIEST next
  // occurrence (tomorrow's am), not the pm one. "resets 10" at 23:30 Zurich — 10pm passed
  // 1.5h ago (outside grace), 10am passed 13.5h ago → target 10am tomorrow (~10.5h), not
  // 10pm tomorrow (~22.5h). The grace check uses the most-recent interpretation, but the
  // roll must use the earliest.
  it('ambiguous both-past outside grace rolls to the earliest occurrence (am), not pm', () => {
    const now = new Date('2026-07-07T21:30:00Z'); // 23:30 Zurich
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 10 && hours < 11, `expected ~10.5h (10am tomorrow), got ${hours.toFixed(2)}h`);
  });
  // Ambiguous, most-recent interpretation just passed (within grace): retry promptly.
  it('ambiguous within-grace (most-recent interpretation just passed) retries promptly', () => {
    const now = new Date('2026-07-07T20:30:00Z'); // 22:30 Zurich, 30 min after the 10pm interpretation
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true }, 60, 5, now
    );
    assert.ok(wait / 60_000 < 5, `expected a prompt retry (~margin), got ${(wait / 60_000).toFixed(1)}min`);
  });
  it('handles relative time correctly', () => {
    const wait = calculateWaitMs({ relative: true, waitMs: 300_000 }, 60, 5);
    assert.ok(Math.abs(wait - 360_000) < 2000); // 5 min + 60s margin
  });
  it('falls back on invalid timezone', () => {
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Invalid/Zone' }, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000); // fallback
  });

  // Regression (#6): in a positive-offset tz, 10:02 AM Melbourne (UTC+10)
  // looking for "11:40pm Melbourne" should wait ~13.6h (today), not ~37.6h.
  it('targets today for a future reset in a positive-offset timezone', () => {
    const now = new Date('2026-05-03T00:02:15Z'); // 10:02 AM in Melbourne (UTC+10)
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 13 && hours < 14, `expected ~13.6h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): negative-offset tz, "resets 3am NY" at 1am NY → ~2h.
  it('targets today for a future reset in a negative-offset timezone', () => {
    const now = new Date('2026-05-03T05:00:00Z'); // 1:00 AM in New York (UTC-4 EDT)
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'America/New_York' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 1.9 && hours < 2.1, `expected ~2h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): reset already passed today → target tomorrow (~22.6h),
  // not 48h. Symmetric case for the off-by-a-day bug. (1h20m past → beyond the grace
  // window below, so it still rolls to tomorrow.)
  it('targets tomorrow when reset time already passed today', () => {
    const now = new Date('2026-05-03T15:00:00Z'); // 1:00 AM next day in Melbourne
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 22 && hours < 23, `expected ~22.6h, got ${hours.toFixed(2)}h`);
  });

  // Reset-boundary grace window: detecting a limit banner whose reset time only JUST
  // passed (the monitor can settle on the banner minutes-to-~an-hour after the reset,
  // e.g. a session that kept working past it) must retry promptly — the limit has
  // effectively reset — not park ~24h by rolling to tomorrow. Reproduces the live
  // "resets 10am" stall: detected 10:03 Zurich, previously waited 86273s (~24h).
  it('retries promptly when the reset time only just passed (grace window)', () => {
    const now = new Date('2026-07-07T08:03:06Z'); // 10:03 Zurich, 3 min after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    const mins = wait / 60_000;
    assert.ok(mins < 5, `expected a prompt retry (~margin), got ${mins.toFixed(1)}min`);
  });
  it('applies the grace window within the hour after the reset', () => {
    const now = new Date('2026-07-07T08:55:00Z'); // 10:55 Zurich, 55 min after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    assert.ok(wait / 60_000 < 5, 'within 1h grace → prompt retry');
  });
  it('still rolls to tomorrow once the reset is well over an hour past', () => {
    const now = new Date('2026-07-07T10:00:00Z'); // 12:00 Zurich, 2h after a 10am reset
    const wait = calculateWaitMs(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 21 && hours < 23, `expected ~22h (tomorrow), got ${hours.toFixed(2)}h`);
  });
});

// --- Weekly limits: a reset that names its calendar date ("resets Oct 9, 10am") ---
// Previously unrecognised: parseResetTime returned null (or, for a bare clock, read only the
// time of day), so a limit days away was treated as a same-day reset.
describe('parseResetTime — dated (weekly) resets', () => {
  it('parses "resets Oct 9, 10am"', () => {
    const r = parseResetTime("You've hit your weekly limit · resets Oct 9, 10am");
    assert.deepEqual([r.month, r.day, r.hour, r.minute, r.year], [10, 9, 10, 0, null]);
    assert.equal(r.timezone, null);
  });
  it('parses "Resets Sep 19 at 6:30am (Asia/Calcutta)"', () => {
    const r = parseResetTime('Resets Sep 19 at 6:30am (Asia/Calcutta)');
    assert.deepEqual([r.month, r.day, r.hour, r.minute], [9, 19, 6, 30]);
    assert.equal(r.timezone, 'Asia/Calcutta');
  });
  it('accepts full month names, ordinals and an explicit year', () => {
    const r = parseResetTime('resets on December 3rd, 2026 at 2:30pm (UTC)');
    assert.deepEqual([r.month, r.day, r.year, r.hour, r.minute], [12, 3, 2026, 14, 30]);
  });
  it('does not mistake the year for the hour', () => {
    const r = parseResetTime('resets Oct 12 2026 at 9am (UTC)');
    assert.deepEqual([r.year, r.hour], [2026, 9]);
  });
  it('handles 12am / 12pm on a dated reset', () => {
    assert.equal(parseResetTime('resets Oct 9, 12am (UTC)').hour, 0);
    assert.equal(parseResetTime('resets Oct 9, 12pm (UTC)').hour, 12);
  });
  it('returns null for a date with no time of day (falls back instead of guessing midnight)', () => {
    assert.equal(parseResetTime('weekly limit resets Oct 9'), null);
  });
  it('returns null for an impossible day', () => {
    assert.equal(parseResetTime('resets Oct 40, 10am'), null);
  });
  it('does not treat a plain clock reset as dated', () => {
    assert.equal(parseResetTime('resets 3pm (UTC)').month, undefined);
  });
  it('on a line with both shapes, the EARLIER clause wins (never over-wait on a mentioned limit)', () => {
    const both = parseResetTime('5-hour limit resets 3pm (UTC), weekly limit resets Oct 12, 9am (UTC)');
    assert.equal(both.hour, 15);
    assert.equal(both.month, undefined);
    const reversed = parseResetTime('weekly limit resets Oct 12, 9am (UTC), 5-hour limit resets 3pm (UTC)');
    assert.equal(reversed.month, 10);
  });
});

describe('calculateWaitMs — dated (weekly) resets', () => {
  const H = 3600_000;
  const wait = (banner, nowIso) => calculateWaitMs(parseResetTime(banner), 60, 5, new Date(nowIso)) / H;

  it('waits days, not hours, for a reset on a later date', () => {
    // Fri 2026-10-09 12:00Z → Mon 2026-10-12 02:00Z = 62h, + 60s margin
    const h = wait('resets Oct 12 at 2am (UTC)', '2026-10-09T12:00:00Z');
    assert.ok(Math.abs(h - (62 + 1 / 60)) < 0.001, `got ${h}`);
  });
  it('honours the banner timezone, not the host timezone', () => {
    // 2am Calcutta (UTC+5:30) on Oct 12 = Oct 11 20:30Z → 56.5h after Oct 9 12:00Z
    const h = wait('resets Oct 12 at 2am (Asia/Calcutta)', '2026-10-09T12:00:00Z');
    assert.ok(Math.abs(h - (56.5 + 1 / 60)) < 0.001, `got ${h}`);
  });
  it('retries promptly when the date has only just passed (machine slept through the reset)', () => {
    const h = wait('resets Oct 9, 10am (UTC)', '2026-10-09T13:00:00Z');
    assert.ok(h < 0.02, `expected ~margin only, got ${h}h`);
  });
  it('does NOT roll a recently-passed date to next year', () => {
    // Three days late. Rolling to next year would park the session for ~362 days.
    const h = wait('resets Oct 9, 10am (UTC)', '2026-10-12T10:00:00Z');
    assert.ok(h < 0.02, `expected ~margin only, got ${h}h`);
  });
  it('reads a January date seen in late December as next year', () => {
    // 2026-12-30 12:00Z → 2027-01-02 09:00Z = 69h
    const h = wait('resets Jan 2 at 9am (UTC)', '2026-12-30T12:00:00Z');
    assert.ok(Math.abs(h - (69 + 1 / 60)) < 0.001, `got ${h}`);
  });
  it('reads a stale December date seen in early January as already past, not next December', () => {
    const h = wait('resets Dec 30 at 9am (UTC)', '2027-01-03T12:00:00Z');
    assert.ok(h < 0.02, `expected ~margin only, got ${h}h`);
  });
  it('an explicit year is used as given', () => {
    const h = wait('resets Oct 12 2026 at 2am (UTC)', '2026-10-09T12:00:00Z');
    assert.ok(Math.abs(h - (62 + 1 / 60)) < 0.001, `got ${h}`);
  });
  it('is DST-correct across a US fall-back between now and the reset', () => {
    // 2026-10-30 09:00 EDT (13:00Z) → Mon 2026-11-02 09:00 EST (14:00Z): 73h, since Nov 1 has 25h.
    const h = wait('resets Nov 2 at 9am (America/New_York)', '2026-10-30T13:00:00Z');
    assert.ok(Math.abs(h - (73 + 1 / 60)) < 0.001, `got ${h}`);
  });
});
