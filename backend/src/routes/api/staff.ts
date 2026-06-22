import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../db';
import { requireAuth, requireRole, StaffRequest } from '../../auth/middleware';
import { createError } from '../../middleware/errorHandler';

const router = Router();

// PATCH /api/v1/staff/:id/permissions — Admin only
// Updates can_trigger_outreach and/or can_edit_schedule for a staff member.
// Viewer role ignores these flags — enforced here.
router.patch(
  '/staff/:id/permissions',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { businessId } = (req as StaffRequest).staff;
      const { can_trigger_outreach, can_edit_schedule } = req.body as {
        can_trigger_outreach?: boolean;
        can_edit_schedule?: boolean;
      };

      if (can_trigger_outreach === undefined && can_edit_schedule === undefined) {
        return next(createError('INVALID_INPUT', 'At least one permission flag must be provided.', 400));
      }

      // Fetch target staff member — must belong to same business
      const target = await db.query<{ id: string; role: string }>(
        'SELECT id, role FROM staff_user WHERE id = $1 AND business_id = $2 LIMIT 1',
        [id, businessId],
      );

      if (!target.rows[0]) {
        return next(createError('NOT_FOUND', 'Staff member not found.', 404));
      }

      if (target.rows[0].role === 'viewer') {
        return next(createError('FORBIDDEN', 'Designatable permissions cannot be assigned to a Viewer.', 403));
      }

      // Build dynamic SET clause for only the provided fields
      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (can_trigger_outreach !== undefined) {
        updates.push(`can_trigger_outreach = $${idx++}`);
        values.push(can_trigger_outreach);
      }
      if (can_edit_schedule !== undefined) {
        updates.push(`can_edit_schedule = $${idx++}`);
        values.push(can_edit_schedule);
      }

      values.push(id, businessId);
      await db.query(
        `UPDATE staff_user SET ${updates.join(', ')} WHERE id = $${idx++} AND business_id = $${idx}`,
        values,
      );

      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// GET /api/v1/staff — Admin only (list all staff for this business)
router.get(
  '/staff',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const result = await db.query<{
        id: string; email: string; role: string;
        can_trigger_outreach: boolean; can_edit_schedule: boolean;
      }>(
        'SELECT id, email, role, can_trigger_outreach, can_edit_schedule FROM staff_user WHERE business_id = $1 ORDER BY role, email',
        [businessId],
      );
      res.json({ data: result.rows });
    } catch (err) { next(err); }
  },
);

// PATCH /api/v1/staff/:id/role — Admin only
router.patch(
  '/staff/:id/role',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: requesterId, businessId } = (req as StaffRequest).staff;
      const targetId = req.params.id;
      const { role } = req.body as { role?: string };

      if (!role || !['admin', 'staff', 'viewer'].includes(role)) {
        return next(createError('INVALID_INPUT', 'role must be admin, staff, or viewer.', 400));
      }
      if (targetId === requesterId) {
        return next(createError('FORBIDDEN', 'Cannot change your own role.', 403));
      }

      const target = await db.query<{ id: string; role: string }>(
        `SELECT id, role FROM staff_user WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [targetId, businessId],
      );
      if (!target.rows[0]) return next(createError('NOT_FOUND', 'Staff member not found.', 404));
      if (target.rows[0].role === 'deactivated') {
        return next(createError('FORBIDDEN', 'Cannot change role of a deactivated account.', 403));
      }

      if (role === 'viewer') {
        await db.query(
          `UPDATE staff_user SET role = $1, can_trigger_outreach = false, can_edit_schedule = false WHERE id = $2`,
          [role, targetId],
        );
      } else {
        await db.query(`UPDATE staff_user SET role = $1 WHERE id = $2`, [role, targetId]);
      }

      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// DELETE /api/v1/staff/:id — Admin only (soft-delete)
router.delete(
  '/staff/:id',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: requesterId, businessId } = (req as StaffRequest).staff;
      const targetId = req.params.id;

      if (targetId === requesterId) {
        return next(createError('FORBIDDEN', 'Cannot deactivate your own account.', 403));
      }

      const target = await db.query<{ id: string }>(
        `SELECT id FROM staff_user WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [targetId, businessId],
      );
      if (!target.rows[0]) return next(createError('NOT_FOUND', 'Staff member not found.', 404));

      await db.query(
        `UPDATE staff_user SET
           role = 'deactivated',
           refresh_token_hash = NULL,
           refresh_token_expires_at = NULL,
           invite_token_hash = NULL,
           invite_token_expires_at = NULL
         WHERE id = $1`,
        [targetId],
      );

      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

export default router;
