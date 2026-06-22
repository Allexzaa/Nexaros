/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('device_token', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'client', onDelete: 'CASCADE' },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    token: { type: 'text', notNull: true },
    platform: {
      type: 'text',
      notNull: true,
      check: "platform IN ('ios', 'android')",
    },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One token per device type per client
  pgm.addConstraint('device_token', 'device_token_client_platform_unique', 'UNIQUE (client_id, platform)');
};

exports.down = (pgm) => {
  pgm.dropTable('device_token');
};
