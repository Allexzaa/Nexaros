import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../db';
import { runConversationAgent } from '../../ai/conversationAgent';
import { createError } from '../../middleware/errorHandler';

// Dev-only route — simulates a client reply without needing Twilio.
// Disabled in production.
const router = Router();

if (process.env.NODE_ENV !== 'production') {
  router.post('/dev/simulate-reply', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { conversationId, message } = req.body as { conversationId?: string; message?: string };

      if (!conversationId || !message?.trim()) {
        return next(createError('INVALID_INPUT', 'conversationId and message are required.', 400));
      }

      const convRow = await db.query<{ id: string; state: string; client_id: string }>(
        `SELECT id, state, client_id FROM conversation WHERE id = $1 LIMIT 1`,
        [conversationId],
      );
      if (!convRow.rows[0]) return next(createError('NOT_FOUND', 'Conversation not found.', 404));

      const terminal = ['confirmed', 'cancelled', 'resolved', 'no_response'];
      if (terminal.includes(convRow.rows[0].state)) {
        return next(createError('INVALID_STATE', `Conversation is in terminal state: ${convRow.rows[0].state}`, 409));
      }

      // Fire and return immediately — processing is async
      runConversationAgent(conversationId, message.trim()).catch(err =>
        console.error('[dev/simulate-reply] runConversationAgent error:', err),
      );

      res.json({ ok: true, conversationId, message: message.trim(), note: 'Processing started — refresh conversation to see AI response.' });
    } catch (err) { next(err); }
  });
}

export default router;
