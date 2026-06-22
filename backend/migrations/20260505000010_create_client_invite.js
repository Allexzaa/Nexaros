/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('client_invite', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'client', onDelete: 'CASCADE' },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    short_code: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('client_invite', 'short_code');
};

exports.down = (pgm) => {
  pgm.dropTable('client_invite');
};
