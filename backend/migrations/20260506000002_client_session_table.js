/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('client_session', {
    id:            { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id:     { type: 'uuid', notNull: true, references: 'client(id)', onDelete: 'CASCADE', unique: true },
    business_id:   { type: 'uuid', notNull: true, references: 'business(id)', onDelete: 'CASCADE' },
    session_token: { type: 'text', notNull: true, unique: true },
    expires_at:    { type: 'timestamptz', notNull: true },
    created_at:    { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('client_session', 'session_token');
};

exports.down = (pgm) => {
  pgm.dropTable('client_session');
};
