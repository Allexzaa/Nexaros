/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('appointment', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    schedule_id: { type: 'uuid', notNull: true, references: 'schedule', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', references: 'client' },
    starts_at: { type: 'timestamptz', notNull: true },
    service_type: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: pgm.func("'available'"),
      check: "status IN ('available', 'pending-outreach', 'ai-active', 'confirmed', 'rescheduled', 'cancelled', 'no-response')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('appointment', ['business_id', 'status']);
  pgm.createIndex('appointment', 'schedule_id');
};

exports.down = (pgm) => {
  pgm.dropTable('appointment');
};
