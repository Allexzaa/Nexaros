/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('staff_user', {
    id: { type: 'uuid', notNull: true, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    business_id: { type: 'uuid', notNull: true, references: 'business', onDelete: 'CASCADE' },
    email: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, check: "role IN ('admin', 'staff', 'viewer')" },
    can_trigger_outreach: { type: 'boolean', notNull: true, default: false },
    can_edit_schedule: { type: 'boolean', notNull: true, default: false },
    password_hash: { type: 'text' },
    google_id: { type: 'text' },
    refresh_token_hash: { type: 'text' },
    refresh_token_expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('staff_user', 'staff_user_business_email_unique', 'UNIQUE (business_id, email)');
};

exports.down = (pgm) => {
  pgm.dropTable('staff_user');
};
