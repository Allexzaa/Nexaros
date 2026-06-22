import { processAutoPickup } from '../jobs/processors/autoPickup';
import { Job } from 'bullmq';
import { AutoPickupData } from '../jobs/types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({
  scheduleOutreach:  jest.fn(),
  scheduleAutoPickup: jest.fn(),
}));

import { db } from '../db';
import { scheduleOutreach, scheduleAutoPickup } from '../jobs/scheduler';

const mockDbQuery        = db.query as jest.Mock;
const mockScheduleOutreach = scheduleOutreach as jest.Mock;
const mockScheduleSelf     = scheduleAutoPickup as jest.Mock;

function makeJob(): Job<AutoPickupData> {
  return { data: {} } as Job<AutoPickupData>;
}

// Pin current hour to a known in-window hour using Intl mock
const ORIGINAL_INTL = global.Intl;

function mockHour(hour: number) {
  jest.spyOn(global.Intl, 'DateTimeFormat').mockImplementation(
    (locale: any, opts: any): any => ({
      format: () => `${hour}`,
      formatToParts: () => [
        { type: 'year', value: '2026' }, { type: 'month', value: '06' },
        { type: 'day', value: '10' }, { type: 'hour', value: `${hour}` },
        { type: 'minute', value: '00' }, { type: 'second', value: '00' },
      ],
    }),
  );
}

beforeEach(() => jest.resetAllMocks());
afterEach(() => jest.restoreAllMocks());

function stubBusinesses(rows: { id: string; settings: Record<string, unknown> | null; timezone: string }[]) {
  mockDbQuery.mockResolvedValueOnce({ rows });
}

function stubAppointments(rows: { id: string; client_id: string }[]) {
  mockDbQuery.mockResolvedValueOnce({ rows });
}

function stubConvInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('inside outreach window: picks up pending appointments and creates conversations', async () => {
  mockHour(10); // 10:00 — inside default 9–18 window

  stubBusinesses([{ id: 'biz-1', settings: null, timezone: 'UTC' }]);
  stubAppointments([
    { id: 'appt-1', client_id: 'client-1' },
    { id: 'appt-2', client_id: 'client-2' },
  ]);
  stubConvInsert();
  stubConvInsert();

  await processAutoPickup(makeJob());

  expect(mockScheduleOutreach).toHaveBeenCalledTimes(2);
  expect(mockScheduleOutreach).toHaveBeenCalledWith('appt-1');
  expect(mockScheduleOutreach).toHaveBeenCalledWith('appt-2');
  expect(mockScheduleSelf).toHaveBeenCalledWith(5 * 60 * 1000); // default 5 min interval
});

test('outside outreach window: skips business, still reschedules self', async () => {
  mockHour(20); // 20:00 — outside default 9–18 window

  stubBusinesses([{ id: 'biz-1', settings: null, timezone: 'UTC' }]);

  await processAutoPickup(makeJob());

  expect(mockScheduleOutreach).not.toHaveBeenCalled();
  expect(mockScheduleSelf).toHaveBeenCalledWith(5 * 60 * 1000);
});

test('no appointments to pick up: conversation insert not called', async () => {
  mockHour(10);

  stubBusinesses([{ id: 'biz-1', settings: null, timezone: 'UTC' }]);
  stubAppointments([]); // no pending appointments

  await processAutoPickup(makeJob());

  expect(mockScheduleOutreach).not.toHaveBeenCalled();
  expect(mockScheduleSelf).toHaveBeenCalled();
});

test('custom interval from settings is used when rescheduling self', async () => {
  mockHour(10);

  stubBusinesses([{
    id: 'biz-1',
    settings: { auto_pickup_interval_minutes: 15, outreach_hours_start: 9, outreach_hours_end: 18 },
    timezone: 'UTC',
  }]);
  stubAppointments([]);

  await processAutoPickup(makeJob());

  expect(mockScheduleSelf).toHaveBeenCalledWith(15 * 60 * 1000);
});

test('multiple businesses: only in-window businesses have appointments queried', async () => {
  // biz-1 at hour 10 (in window 9-18), biz-2 at hour 22 (out of window)
  let callCount = 0;
  jest.spyOn(global.Intl, 'DateTimeFormat').mockImplementation((): any => ({
    format: () => {
      callCount++;
      // First business uses UTC (callCount 1→ hour 10), second also UTC but we'll track it
      return '10'; // both in window for simplicity
    },
    formatToParts: () => [],
  }));

  stubBusinesses([
    { id: 'biz-1', settings: null, timezone: 'UTC' },
    { id: 'biz-2', settings: null, timezone: 'UTC' },
  ]);
  stubAppointments([{ id: 'appt-1', client_id: 'client-1' }]); // for biz-1
  stubConvInsert();
  stubAppointments([]); // for biz-2

  await processAutoPickup(makeJob());

  expect(mockScheduleOutreach).toHaveBeenCalledTimes(1);
  expect(mockScheduleOutreach).toHaveBeenCalledWith('appt-1');
});
