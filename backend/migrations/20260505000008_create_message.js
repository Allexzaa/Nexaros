/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('message', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    conversation_id: { type: 'uuid', notNull: true, references: 'conversation', onDelete: 'CASCADE' },
    sender: {
      type: 'text',
      notNull: true,
      check: "sender IN ('ai', 'client', 'staff')",
    },
    content: { type: 'text', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('message', 'conversation_id');
};

exports.down = (pgm) => {
  pgm.dropTable('message');
};
