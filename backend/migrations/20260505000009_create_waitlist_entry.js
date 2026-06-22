/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('waitlist_entry', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'client' },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    preferences: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: pgm.func("'waiting'"),
      check: "status IN ('waiting', 'notified', 'scheduled')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('waitlist_entry', ['business_id', 'status', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('waitlist_entry');
};
