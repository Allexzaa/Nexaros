import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole, StaffRequest } from '../../auth/middleware';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { stateEngine } from '../../ai/stateEngine';
import { cancelJobsByConversationId } from '../../jobs/scheduler';
import { runConversationAgent } from '../../ai/conversationAgent';
import { emitTakeoverStarted, emitNewMessage } from '../../realtime/emitters';
import { findBestSlot } from '../../services/slotManager';
import { ConversationEvent, TransitionExtras } from '../../ai/types';
import { MessageRecord } from '../../realtime/types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET /api/v1/conversations — paginated list, escalated first
router.get('/conversations', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const limit  = Math.min(parseInt(req.query.limit  as string ?? '20', 10), 100);
    const offset = Math.max(parseInt(req.query.offset as string ?? '0',  10), 0);
    const stateFilter = req.query.state as string | undefined;

    const params: unknown[] = [businessId, limit, offset];
    const stateClause = stateFilter ? `AND c.state = $${params.push(stateFilter)}` : '';

    const result = await db.query<{
      id: string;
      state: string;
      client_id: string;
      client_name: string;
      appointment_id: string;
      starts_at: Date;
      service_type: string | null;
      follow_up_count: number;
      escalation_reason: string | null;
      created_at: Date;
    }>(
      `SELECT c.id, c.state, c.client_id, cl.name AS client_name,
              c.appointment_id, a.starts_at, a.service_type,
              c.follow_up_count, c.escalation_reason, c.created_at
       FROM conversation c
       JOIN client cl ON cl.id = c.client_id
       JOIN appointment a ON a.id = c.appointment_id
       WHERE c.business_id = $1 ${stateClause}
       ORDER BY
         CASE WHEN c.state = 'escalated' THEN 0 ELSE 1 END ASC,
         c.created_at DESC
       LIMIT $2 OFFSET $3`,
      params,
    );

    res.json({ data: result.rows, limit, offset });
  } catch (err) { next(err); }
});

// GET /api/v1/conversations/:id — detail with messages
router.get('/conversations/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const conversationId = req.params.id;

    const convResult = await db.query<{
      id: string;
      state: string;
      client_id: string;
      client_name: string;
      appointment_id: string;
      starts_at: Date;
      service_type: string | null;
      follow_up_count: number;
      consecutive_ambiguous_count: number;
      escalation_reason: string | null;
      context_summary: string | null;
      taken_over_by: string | null;
      created_at: Date;
    }>(
      `SELECT c.id, c.state, c.client_id, cl.name AS client_name,
              c.appointment_id, a.starts_at, a.service_type,
              c.follow_up_count, c.consecutive_ambiguous_count,
              c.escalation_reason, c.context_summary,
              c.taken_over_by, c.created_at
       FROM conversation c
       JOIN client cl ON cl.id = c.client_id
       JOIN appointment a ON a.id = c.appointment_id
       WHERE c.id = $1 AND c.business_id = $2`,
      [conversationId, businessId],
    );

    if (!convResult.rows[0]) {
      return next(createError('NOT_FOUND', 'Conversation not found.', 404));
    }

    const messagesResult = await db.query<{
      id: string; sender: string; content: string; timestamp: Date;
    }>(
      `SELECT id, sender, content, timestamp FROM message WHERE conversation_id = $1 ORDER BY timestamp ASC`,
      [conversationId],
    );

    res.json({
      ...convResult.rows[0],
      messages: messagesResult.rows,
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/conversations/:id/takeover — staff takes over from AI
router.patch(
  '/conversations/:id/takeover',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId, id: staffId } = (req as StaffRequest).staff;
      const conversationId = req.params.id;

      const convResult = await db.query<{ client_id: string; state: string }>(
        `SELECT client_id, state FROM conversation WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [conversationId, businessId],
      );
      if (!convResult.rows[0]) {
        return next(createError('NOT_FOUND', 'Conversation not found.', 404));
      }

      const { client_id, state } = convResult.rows[0];

      await stateEngine.applyTransition(conversationId, 'staff_takeover');
      await db.query(`UPDATE conversation SET taken_over_by = $1 WHERE id = $2`, [staffId, conversationId]);
      await cancelJobsByConversationId(conversationId);
      emitTakeoverStarted(client_id, conversationId);

      res.json({ conversationId, state: 'staff_active', takenOverBy: staffId });
    } catch (err) { next(err); }
  },
);

// PATCH /api/v1/conversations/:id/return — return conversation to AI
router.patch(
  '/conversations/:id/return',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const conversationId = req.params.id;

      const convResult = await db.query<{ state: string }>(
        `SELECT state FROM conversation WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [conversationId, businessId],
      );
      if (!convResult.rows[0]) {
        return next(createError('NOT_FOUND', 'Conversation not found.', 404));
      }
      if (convResult.rows[0].state !== 'staff_active') {
        return next(createError('INVALID_STATE', 'Conversation is not in staff_active state.', 409));
      }

      await stateEngine.applyTransition(conversationId, 'staff_returns_to_ai');
      await db.query(`UPDATE conversation SET taken_over_by = NULL WHERE id = $1`, [conversationId]);

      // Re-engage AI if the last message was from the client
      const lastMsg = await db.query<{ sender: string; content: string }>(
        `SELECT sender, content FROM message WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT 1`,
        [conversationId],
      );
      if (lastMsg.rows[0]?.sender === 'client') {
        runConversationAgent(conversationId, lastMsg.rows[0].content).catch((err) =>
          console.error(`[conversations/return] runConversationAgent error:`, err),
        );
      }

      res.json({ conversationId, state: 'awaiting_reply' });
    } catch (err) { next(err); }
  },
);

// PATCH /api/v1/conversations/:id/close — force-close to resolved
router.patch(
  '/conversations/:id/close',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const conversationId = req.params.id;

      const convResult = await db.query<{ state: string }>(
        `SELECT state FROM conversation WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [conversationId, businessId],
      );
      if (!convResult.rows[0]) {
        return next(createError('NOT_FOUND', 'Conversation not found.', 404));
      }

      await stateEngine.applyTransition(conversationId, 'staff_forces_close');
      await cancelJobsByConversationId(conversationId);

      res.json({ conversationId, state: 'resolved' });
    } catch (err) { next(err); }
  },
);

// PATCH /api/v1/conversations/:id/booking — approve or reject an in-chat booking request
router.patch(
  '/conversations/:id/booking',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const conversationId = req.params.id;
      const { action } = req.body as { action?: string };

      if (action !== 'approve' && action !== 'reject') {
        return next(createError('INVALID_INPUT', 'action must be "approve" or "reject".', 400));
      }

      const convResult = await db.query<{
        state: string; client_id: string; appointment_id: string; timezone: string;
      }>(
        `SELECT c.state, c.client_id, c.appointment_id, b.timezone
         FROM conversation c JOIN business b ON b.id = c.business_id
         WHERE c.id = $1 AND c.business_id = $2 LIMIT 1`,
        [conversationId, businessId],
      );
      if (!convResult.rows[0]) {
        return next(createError('NOT_FOUND', 'Conversation not found.', 404));
      }
      if (convResult.rows[0].state !== 'awaiting_approval') {
        return next(createError('INVALID_STATE', 'Conversation is not awaiting approval.', 409));
      }

      const { client_id, appointment_id, timezone } = convResult.rows[0];
      const tz = timezone || 'America/Los_Angeles';

      await cancelJobsByConversationId(conversationId);

      const slot = await findBestSlot(businessId, '', appointment_id, tz);

      const event: ConversationEvent = action === 'approve' ? 'staff_approved_booking' : 'staff_rejected_booking';
      const extras: TransitionExtras = {};
      let responseText: string;

      if (slot) {
        const slotDate = new Intl.DateTimeFormat('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: tz,
        }).format(new Date(slot.starts_at));
        const serviceLabel = slot.service_type ? `your ${slot.service_type}` : 'an appointment';
        responseText = action === 'approve'
          ? `Great news — I've found ${serviceLabel} on ${slotDate}. Would that work for you?`
          : `Unfortunately the office isn't able to accommodate that request. I found ${serviceLabel} on ${slotDate} — would that work instead?`;
        extras.targetState = 'slot_offered';
        extras.offeredSlotId = slot.id;
      } else {
        responseText = action === 'approve'
          ? "I've checked and there are no available slots right now. I've added you to the waitlist and will let you know when something opens up."
          : "Unfortunately the office isn't able to accommodate that request, and there are no other slots available. I've added you to the waitlist.";
        extras.targetState = 'waitlisted';
      }

      await stateEngine.applyTransition(conversationId, event, extras);

      if (extras.targetState === 'waitlisted') {
        await db.query(
          `INSERT INTO waitlist_entry (id, client_id, business_id, preferences) VALUES ($1, $2, $3, $4)`,
          [uuidv4(), client_id, businessId, ''],
        );
      }

      const msgResult = await db.query<{ id: string; timestamp: Date }>(
        `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'ai', $3) RETURNING id, timestamp`,
        [uuidv4(), conversationId, responseText],
      );

      const messageRecord: MessageRecord = {
        id: msgResult.rows[0].id,
        sender: 'ai',
        content: responseText,
        timestamp: msgResult.rows[0].timestamp.toISOString(),
      };
      emitNewMessage(businessId, client_id, conversationId, messageRecord);

      res.json({ conversationId, state: extras.targetState });
    } catch (err) { next(err); }
  },
);

// POST /api/v1/conversations/:id/messages — staff sends a message while in staff_active
router.post(
  '/conversations/:id/messages',
  requireAuth,
  requireRole('admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId, id: staffId } = (req as StaffRequest).staff;
      const conversationId = req.params.id;
      const { content } = req.body as { content?: string };

      if (!content || typeof content !== 'string' || !content.trim()) {
        return next(createError('INVALID_INPUT', 'Message content is required.', 400));
      }

      const convResult = await db.query<{ state: string; client_id: string; taken_over_by: string | null }>(
        `SELECT state, client_id, taken_over_by FROM conversation WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [conversationId, businessId],
      );
      if (!convResult.rows[0]) {
        return next(createError('NOT_FOUND', 'Conversation not found.', 404));
      }

      const { state, client_id, taken_over_by } = convResult.rows[0];
      if (state !== 'staff_active') {
        return next(createError('INVALID_STATE', 'Staff can only send messages when the conversation is in staff_active state.', 409));
      }
      if (taken_over_by !== staffId) {
        return next(createError('FORBIDDEN', 'Only the staff member who took over can send messages.', 403));
      }

      const msgId = uuidv4();
      const msgResult = await db.query<{ id: string; timestamp: Date }>(
        `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'staff', $3) RETURNING id, timestamp`,
        [msgId, conversationId, content.trim()],
      );

      const messageRecord: MessageRecord = {
        id:        msgResult.rows[0].id,
        sender:    'staff',
        content:   content.trim(),
        timestamp: msgResult.rows[0].timestamp.toISOString(),
      };
      emitNewMessage(businessId, client_id, conversationId, messageRecord);

      res.status(201).json(messageRecord);
    } catch (err) { next(err); }
  },
);

export default router;
