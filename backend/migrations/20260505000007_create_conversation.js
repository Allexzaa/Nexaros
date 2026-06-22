/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('conversation', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'client' },
    appointment_id: { type: 'uuid', notNull: true, references: 'appointment', onDelete: 'CASCADE' },
    taken_over_by: { type: 'uuid', references: 'staff_user' },
    follow_up_count: { type: 'integer', notNull: true, default: 0 },
    next_follow_up_at: { type: 'timestamptz' },
    state: {
      type: 'text',
      notNull: true,
      default: pgm.func("'idle'"),
      check: "state IN ('idle', 'awaiting_reply', 'processing', 'confirming', 'rescheduling', 'slot_offered', 'waitlisted', 'escalated', 'staff_active', 'confirmed', 'no_response', 'cancelled', 'resolved', 'awaiting_approval')",
    },
    offered_slot_id: { type: 'uuid', references: 'appointment' },
    escalation_reason: { type: 'text' },
    consecutive_ambiguous_count: { type: 'integer', notNull: true, default: 0 },
    context_summary: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One conversation per booking episode
  pgm.addConstraint('conversation', 'conversation_appointment_id_unique', 'UNIQUE (appointment_id)');
};

exports.down = (pgm) => {
  pgm.dropTable('conversation');
};
