/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('client', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    app_registered: { type: 'boolean', notNull: true, default: false },
    opted_out: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('client', 'business_id');
};

exports.down = (pgm) => {
  pgm.dropTable('client');
};
