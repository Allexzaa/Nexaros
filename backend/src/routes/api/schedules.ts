import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requirePermission, StaffRequest } from '../../auth/middleware';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { scheduleOutreach } from '../../jobs/scheduler';

const router = Router();

function todayPST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function datePST(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// GET /api/v1/schedules — paginated list with appointment count
router.get('/schedules', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const limit  = Math.min(parseInt(req.query.limit  as string ?? '20', 10), 100);
    const offset = Math.max(parseInt(req.query.offset as string ?? '0',  10), 0);

    const result = await db.query<{ id: string; date: string; appointment_count: string; created_at: Date }>(
      `SELECT s.id, s.date::text, s.created_at,
              COUNT(a.id)::text AS appointment_count
       FROM schedule s
       LEFT JOIN appointment a ON a.schedule_id = s.id
       WHERE s.business_id = $1
       GROUP BY s.id
       ORDER BY s.date DESC
       LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    );

    res.json({
      data: result.rows.map(r => ({ ...r, appointment_count: parseInt(r.appointment_count, 10) })),
      limit,
      offset,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/schedules — create schedule (PST date validation, no duplicate)
router.post('/schedules', requireAuth, requirePermission('canEditSchedule'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId, id: staffId } = (req as StaffRequest).staff;
    const { date } = req.body as { date?: string };

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return next(createError('INVALID_INPUT', 'date must be a valid YYYY-MM-DD string.', 400));
    }
    if (date < todayPST()) {
      return next(createError('INVALID_INPUT', 'date must not be in the past (PST).', 400));
    }

    const existing = await db.query<{ id: string }>(
      `SELECT id FROM schedule WHERE business_id = $1 AND date = $2 LIMIT 1`,
      [businessId, date],
    );
    if (existing.rows[0]) {
      return next(createError('SCHEDULE_EXISTS', 'A schedule for this date already exists.', 409));
    }

    const id = uuidv4();
    const row = await db.query<{ id: string; date: string; created_at: Date }>(
      `INSERT INTO schedule (id, business_id, date, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, date::text, created_at`,
      [id, businessId, date, staffId],
    );

    res.status(201).json(row.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/v1/schedules/:id — detail with appointments + client names
router.get('/schedules/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const scheduleId = req.params.id;

    const schedResult = await db.query<{ id: string; date: string; created_at: Date }>(
      `SELECT id, date::text, created_at FROM schedule WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [scheduleId, businessId],
    );
    if (!schedResult.rows[0]) return next(createError('NOT_FOUND', 'Schedule not found.', 404));

    const apptResult = await db.query<{
      id: string; starts_at: Date; service_type: string | null;
      status: string; client_id: string | null; client_name: string | null;
    }>(
      `SELECT a.id, a.starts_at, a.service_type, a.status, a.client_id,
              cl.name AS client_name
       FROM appointment a
       LEFT JOIN client cl ON cl.id = a.client_id
       WHERE a.schedule_id = $1
       ORDER BY a.starts_at ASC`,
      [scheduleId],
    );

    res.json({ ...schedResult.rows[0], appointments: apptResult.rows });
  } catch (err) { next(err); }
});

// POST /api/v1/schedules/:id/appointments — add slot (PST date match validation)
router.post(
  '/schedules/:id/appointments',
  requireAuth,
  requirePermission('canEditSchedule'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const scheduleId = req.params.id;
      const { starts_at, service_type, client_id } = req.body as {
        starts_at?: string; service_type?: string; client_id?: string;
      };

      if (!starts_at || isNaN(Date.parse(starts_at))) {
        return next(createError('INVALID_INPUT', 'starts_at must be a valid ISO datetime.', 400));
      }
      if (new Date(starts_at) <= new Date()) {
        return next(createError('INVALID_INPUT', 'starts_at must be in the future.', 400));
      }

      const schedResult = await db.query<{ id: string; date: string }>(
        `SELECT id, date::text FROM schedule WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [scheduleId, businessId],
      );
      if (!schedResult.rows[0]) return next(createError('NOT_FOUND', 'Schedule not found.', 404));

      if (datePST(starts_at) !== schedResult.rows[0].date) {
        return next(createError('INVALID_INPUT', 'starts_at must fall on the same date as the schedule (PST).', 400));
      }

      if (client_id) {
        const clientRow = await db.query<{ id: string }>(
          `SELECT id FROM client WHERE id = $1 AND business_id = $2 LIMIT 1`,
          [client_id, businessId],
        );
        if (!clientRow.rows[0]) return next(createError('NOT_FOUND', 'Client not found.', 404));
      }

      const status = client_id ? 'pending-outreach' : 'available';
      const apptId = uuidv4();
      const apptRow = await db.query<{
        id: string; starts_at: Date; service_type: string | null; status: string; client_id: string | null;
      }>(
        `INSERT INTO appointment (id, business_id, schedule_id, starts_at, service_type, client_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, starts_at, service_type, status, client_id`,
        [apptId, businessId, scheduleId, starts_at, service_type ?? null, client_id ?? null, status],
      );

      res.status(201).json(apptRow.rows[0]);
    } catch (err) { next(err); }
  },
);

// DELETE /api/v1/schedules/:id/appointments/:apptId — available-only guard
router.delete(
  '/schedules/:id/appointments/:apptId',
  requireAuth,
  requirePermission('canEditSchedule'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const { apptId } = req.params;

      const appt = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM appointment WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [apptId, businessId],
      );
      if (!appt.rows[0]) return next(createError('NOT_FOUND', 'Appointment not found.', 404));
      if (appt.rows[0].status !== 'available') {
        return next(createError('APPOINTMENT_ACTIVE', 'Only available appointments can be deleted.', 409));
      }

      await db.query(`DELETE FROM appointment WHERE id = $1`, [apptId]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// PUT /api/v1/appointments/:id — status auto-update on client_id change
router.put(
  '/appointments/:id',
  requireAuth,
  requirePermission('canEditSchedule'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const apptId = req.params.id;
      const { starts_at, service_type, client_id } = req.body as {
        starts_at?: string; service_type?: string; client_id?: string | null;
      };

      if (starts_at !== undefined && (typeof starts_at !== 'string' || isNaN(Date.parse(starts_at)))) {
        return next(createError('INVALID_INPUT', 'starts_at must be a valid ISO datetime.', 400));
      }

      const appt = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM appointment WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [apptId, businessId],
      );
      if (!appt.rows[0]) return next(createError('NOT_FOUND', 'Appointment not found.', 404));
      if (!['available', 'pending-outreach'].includes(appt.rows[0].status)) {
        return next(createError('APPOINTMENT_ACTIVE', 'Appointment cannot be edited in its current status.', 409));
      }

      if (client_id) {
        const clientRow = await db.query<{ id: string }>(
          `SELECT id FROM client WHERE id = $1 AND business_id = $2 LIMIT 1`,
          [client_id, businessId],
        );
        if (!clientRow.rows[0]) return next(createError('NOT_FOUND', 'Client not found.', 404));
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (starts_at  !== undefined) { updates.push(`starts_at = $${idx++}`);    values.push(starts_at); }
      if (service_type !== undefined) { updates.push(`service_type = $${idx++}`); values.push(service_type); }
      if (client_id !== undefined) {
        updates.push(`client_id = $${idx++}`); values.push(client_id ?? null);
        updates.push(`status = $${idx++}`);    values.push(client_id ? 'pending-outreach' : 'available');
      }

      if (updates.length === 0) {
        return next(createError('INVALID_INPUT', 'At least one field must be provided.', 400));
      }

      values.push(apptId, businessId);
      await db.query(
        `UPDATE appointment SET ${updates.join(', ')} WHERE id = $${idx++} AND business_id = $${idx}`,
        values,
      );

      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// GET /api/v1/appointments/range — all appointments across a date range, grouped by date
router.get('/appointments/range', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const { from, to } = req.query as { from?: string; to?: string };

    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return next(createError('INVALID_INPUT', 'from and to must be YYYY-MM-DD dates.', 400));
    }

    const fromDate = new Date(from);
    const toDate   = new Date(to);
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0 || diffDays > 42) {
      return next(createError('INVALID_INPUT', 'Date range must be between 0 and 42 days.', 400));
    }

    const result = await db.query<{
      schedule_id: string;
      date: string;
      appt_id: string;
      starts_at: Date;
      service_type: string | null;
      status: string;
      client_name: string | null;
    }>(
      `SELECT s.id AS schedule_id, s.date::text,
              a.id AS appt_id, a.starts_at, a.service_type, a.status,
              cl.name AS client_name
       FROM schedule s
       LEFT JOIN appointment a ON a.schedule_id = s.id
       LEFT JOIN client cl ON cl.id = a.client_id
       WHERE s.business_id = $1 AND s.date BETWEEN $2 AND $3
       ORDER BY s.date ASC, a.starts_at ASC`,
      [businessId, from, to],
    );

    // Group by date
    const days: Record<string, { scheduleId: string; slots: unknown[] }> = {};
    for (const row of result.rows) {
      if (!days[row.date]) {
        days[row.date] = { scheduleId: row.schedule_id, slots: [] };
      }
      if (row.appt_id) {
        days[row.date].slots.push({
          id: row.appt_id,
          starts_at: row.starts_at,
          service_type: row.service_type,
          status: row.status,
          client_name: row.client_name,
        });
      }
    }

    res.json({ days });
  } catch (err) { next(err); }
});

// POST /api/v1/schedules/batch — bulk create schedules + available slots
router.post('/schedules/batch', requireAuth, requirePermission('canEditSchedule'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId, id: staffId } = (req as StaffRequest).staff;
    const { dateFrom, dateTo, daysOfWeek, timeStart, timeEnd, intervalMinutes, serviceType } =
      req.body as {
        dateFrom?: string; dateTo?: string;
        daysOfWeek?: number[]; timeStart?: string; timeEnd?: string;
        intervalMinutes?: number; serviceType?: string;
      };

    // Validate
    if (!dateFrom || !dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return next(createError('INVALID_INPUT', 'dateFrom and dateTo must be YYYY-MM-DD.', 400));
    }
    if (dateFrom > dateTo) return next(createError('INVALID_INPUT', 'dateFrom must be ≤ dateTo.', 400));
    const rangeDays = (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000;
    if (rangeDays > 90) return next(createError('INVALID_INPUT', 'Date range cannot exceed 90 days.', 400));

    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0 ||
        daysOfWeek.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      return next(createError('INVALID_INPUT', 'daysOfWeek must be a non-empty array of integers 0–6.', 400));
    }
    const HH_MM = /^\d{2}:\d{2}$/;
    if (!timeStart || !HH_MM.test(timeStart) || !timeEnd || !HH_MM.test(timeEnd) || timeStart >= timeEnd) {
      return next(createError('INVALID_INPUT', 'timeStart and timeEnd must be HH:MM with start < end.', 400));
    }
    if (![15, 30, 45, 60].includes(intervalMinutes as number)) {
      return next(createError('INVALID_INPUT', 'intervalMinutes must be 15, 30, 45, or 60.', 400));
    }

    const nowISO = new Date().toISOString();
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

    let schedulesCreated = 0;
    let slotsCreated = 0;

    // Walk each day in range
    const cursor = new Date(dateFrom + 'T12:00:00Z'); // noon UTC to avoid DST edge
    const end    = new Date(dateTo   + 'T12:00:00Z');

    while (cursor <= end) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dow = cursor.getUTCDay(); // 0=Sun

      if ((daysOfWeek as number[]).includes(dow) && dateStr >= todayStr) {
        // Upsert schedule
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM schedule WHERE business_id = $1 AND date = $2 LIMIT 1`,
          [businessId, dateStr],
        );
        let scheduleId: string;
        if (existing.rows[0]) {
          scheduleId = existing.rows[0].id;
        } else {
          scheduleId = uuidv4();
          await db.query(
            `INSERT INTO schedule (id, business_id, date, created_by) VALUES ($1, $2, $3, $4)`,
            [scheduleId, businessId, dateStr, staffId],
          );
          schedulesCreated++;
        }

        // Generate time slots
        const [startH, startM] = (timeStart as string).split(':').map(Number);
        const [endH,   endM]   = (timeEnd   as string).split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes   = endH   * 60 + endM;

        for (let m = startMinutes; m < endMinutes; m += intervalMinutes as number) {
          const slotH = Math.floor(m / 60).toString().padStart(2, '0');
          const slotM = (m % 60).toString().padStart(2, '0');
          const startsAt = `${dateStr}T${slotH}:${slotM}:00`;

          if (startsAt <= nowISO) continue; // skip past slots

          await db.query(
            `INSERT INTO appointment (id, business_id, schedule_id, starts_at, service_type, status)
             VALUES ($1, $2, $3, $4, $5, 'available')`,
            [uuidv4(), businessId, scheduleId, startsAt, serviceType?.trim() || null],
          );
          slotsCreated++;
        }
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    res.status(201).json({ schedulesCreated, slotsCreated });
  } catch (err) { next(err); }
});

// POST /api/v1/schedules/:id/outreach — triggers AI outreach for all pending-outreach appointments
router.post(
  '/schedules/:id/outreach',
  requireAuth,
  requirePermission('canTriggerOutreach'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const scheduleId = req.params.id;

      const scheduleRow = await db.query<{ id: string }>(
        `SELECT id FROM schedule WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [scheduleId, businessId],
      );
      if (!scheduleRow.rows[0]) {
        return next(createError('NOT_FOUND', 'Schedule not found.', 404));
      }

      const apptResult = await db.query<{ id: string; client_id: string }>(
        `SELECT a.id, a.client_id FROM appointment a
         WHERE a.schedule_id = $1
           AND a.status = 'pending-outreach'
           AND a.client_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM conversation c WHERE c.appointment_id = a.id)`,
        [scheduleId],
      );

      if (!apptResult.rows.length) {
        return res.json({ queued: 0 });
      }

      let queued = 0;
      for (const appt of apptResult.rows) {
        const convId = uuidv4();
        await db.query(
          `INSERT INTO conversation (id, business_id, client_id, appointment_id) VALUES ($1, $2, $3, $4)`,
          [convId, businessId, appt.client_id, appt.id],
        );
        await scheduleOutreach(appt.id);
        queued++;
      }

      res.json({ queued });
    } catch (err) { next(err); }
  },
);

export default router;
