/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('schedule', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    date: { type: 'date', notNull: true },
    created_by: { type: 'uuid', notNull: true, references: 'staff_user' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('schedule', 'business_id');
};

exports.down = (pgm) => {
  pgm.dropTable('schedule');
};
