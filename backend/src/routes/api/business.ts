import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole, StaffRequest } from '../../auth/middleware';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';

const router = Router();

// GET /api/v1/business/settings — any authenticated staff
router.get('/business/settings', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;

    const result = await db.query<{ name: string; timezone: string; slug: string; settings: Record<string, unknown> }>(
      `SELECT name, timezone, slug, settings FROM business WHERE id = $1 LIMIT 1`,
      [businessId],
    );

    if (!result.rows[0]) return next(createError('NOT_FOUND', 'Business not found.', 404));

    res.json({
      name:     result.rows[0].name,
      timezone: result.rows[0].timezone,
      slug:     result.rows[0].slug,
      settings: result.rows[0].settings,
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/business/settings — Admin only
router.patch('/business/settings', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const {
      name,
      timezone,
      slug,
      outreach_response_window_hours,
      outreach_hours_start,
      outreach_hours_end,
      auto_pickup_interval_minutes,
      escalation_keywords,
      booking_approval_timeout_hours,
      // F009 branding & portal settings
      logo_url,
      tagline,
      address,
      booking_instructions,
      client_cancel_window_hours,
      bookings_paused,
    } = req.body as Record<string, unknown>;

    // Validate provided fields
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
        return next(createError('INVALID_INPUT', 'name must be a non-empty string (max 100 chars).', 400));
      }
    }
    if (timezone !== undefined) {
      if (typeof timezone !== 'string' || timezone.trim().length === 0) {
        return next(createError('INVALID_INPUT', 'timezone must be a valid IANA timezone string.', 400));
      }
      try { Intl.DateTimeFormat('en-US', { timeZone: timezone as string }); } catch {
        return next(createError('INVALID_INPUT', `Invalid timezone: ${timezone}`, 400));
      }
    }
    if (slug !== undefined) {
      if (typeof slug !== 'string' || !/^[a-z0-9-]{2,60}$/.test(slug.trim())) {
        return next(createError('INVALID_INPUT', 'slug must be 2–60 lowercase letters, numbers, or hyphens.', 400));
      }
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM business WHERE slug = $1 AND id != $2 LIMIT 1`,
        [slug.trim(), businessId],
      );
      if (existing.rows[0]) return next(createError('SLUG_TAKEN', 'This URL slug is already taken.', 409));
    }
    if (client_cancel_window_hours !== undefined) {
      const v = Number(client_cancel_window_hours);
      if (!Number.isInteger(v) || v < 1 || v > 168) {
        return next(createError('INVALID_INPUT', 'client_cancel_window_hours must be an integer 1–168.', 400));
      }
    }
    if (bookings_paused !== undefined && typeof bookings_paused !== 'boolean') {
      return next(createError('INVALID_INPUT', 'bookings_paused must be a boolean.', 400));
    }
    if (outreach_response_window_hours !== undefined) {
      const v = Number(outreach_response_window_hours);
      if (!Number.isInteger(v) || v < 1 || v > 168) {
        return next(createError('INVALID_INPUT', 'outreach_response_window_hours must be an integer 1–168.', 400));
      }
    }
    if (outreach_hours_start !== undefined || outreach_hours_end !== undefined) {
      const HH_MM = /^\d{2}:\d{2}$/;
      if (outreach_hours_start !== undefined && (typeof outreach_hours_start !== 'string' || !HH_MM.test(outreach_hours_start))) {
        return next(createError('INVALID_INPUT', 'outreach_hours_start must be HH:MM format.', 400));
      }
      if (outreach_hours_end !== undefined && (typeof outreach_hours_end !== 'string' || !HH_MM.test(outreach_hours_end))) {
        return next(createError('INVALID_INPUT', 'outreach_hours_end must be HH:MM format.', 400));
      }
      if (outreach_hours_start !== undefined && outreach_hours_end !== undefined) {
        if ((outreach_hours_start as string) >= (outreach_hours_end as string)) {
          return next(createError('INVALID_INPUT', 'outreach_hours_start must be before outreach_hours_end.', 400));
        }
      }
    }
    if (auto_pickup_interval_minutes !== undefined) {
      const v = Number(auto_pickup_interval_minutes);
      if (!Number.isInteger(v) || v < 1 || v > 60) {
        return next(createError('INVALID_INPUT', 'auto_pickup_interval_minutes must be an integer 1–60.', 400));
      }
    }
    if (escalation_keywords !== undefined) {
      if (!Array.isArray(escalation_keywords) || escalation_keywords.length > 50 ||
          escalation_keywords.some((k) => typeof k !== 'string' || k.trim().length === 0)) {
        return next(createError('INVALID_INPUT', 'escalation_keywords must be an array of up to 50 non-empty strings.', 400));
      }
    }
    if (booking_approval_timeout_hours !== undefined) {
      const v = Number(booking_approval_timeout_hours);
      if (!Number.isInteger(v) || v < 1 || v > 48) {
        return next(createError('INVALID_INPUT', 'booking_approval_timeout_hours must be an integer 1–48.', 400));
      }
    }

    // Build settings patch from provided fields only
    const settingsPatch: Record<string, unknown> = {};
    if (outreach_response_window_hours !== undefined) settingsPatch.outreach_response_window_hours = outreach_response_window_hours;
    if (outreach_hours_start !== undefined)           settingsPatch.outreach_hours_start = outreach_hours_start;
    if (outreach_hours_end !== undefined)             settingsPatch.outreach_hours_end = outreach_hours_end;
    if (auto_pickup_interval_minutes !== undefined)   settingsPatch.auto_pickup_interval_minutes = auto_pickup_interval_minutes;
    if (escalation_keywords !== undefined)            settingsPatch.escalation_keywords = escalation_keywords;
    if (booking_approval_timeout_hours !== undefined) settingsPatch.booking_approval_timeout_hours = booking_approval_timeout_hours;
    if (logo_url              !== undefined)          settingsPatch.logo_url = logo_url;
    if (tagline               !== undefined)          settingsPatch.tagline = tagline;
    if (address               !== undefined)          settingsPatch.address = address;
    if (booking_instructions  !== undefined)          settingsPatch.booking_instructions = booking_instructions;
    if (client_cancel_window_hours !== undefined)     settingsPatch.client_cancel_window_hours = client_cancel_window_hours;
    if (bookings_paused       !== undefined)          settingsPatch.bookings_paused = bookings_paused;

    const hasName     = name !== undefined;
    const hasTimezone = timezone !== undefined;
    const hasSlug     = slug !== undefined;
    const hasSettings = Object.keys(settingsPatch).length > 0;

    if (!hasName && !hasTimezone && !hasSlug && !hasSettings) {
      return next(createError('INVALID_INPUT', 'At least one field must be provided.', 400));
    }

    // Build direct-column SET clause
    const directSets: string[] = [];
    const directVals: unknown[] = [];
    let idx = 1;
    if (hasName)     { directSets.push(`name = $${idx++}`);     directVals.push((name as string).trim()); }
    if (hasTimezone) { directSets.push(`timezone = $${idx++}`); directVals.push((timezone as string).trim()); }
    if (hasSlug)     { directSets.push(`slug = $${idx++}`);     directVals.push((slug as string).trim()); }

    if (directSets.length > 0 && hasSettings) {
      directSets.push(`settings = settings || $${idx++}::jsonb`);
      directVals.push(JSON.stringify(settingsPatch));
      directVals.push(businessId);
      await db.query(`UPDATE business SET ${directSets.join(', ')} WHERE id = $${idx}`, directVals);
    } else if (directSets.length > 0) {
      directVals.push(businessId);
      await db.query(`UPDATE business SET ${directSets.join(', ')} WHERE id = $${idx}`, directVals);
    } else {
      await db.query(
        `UPDATE business SET settings = settings || $1::jsonb WHERE id = $2`,
        [JSON.stringify(settingsPatch), businessId],
      );
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
