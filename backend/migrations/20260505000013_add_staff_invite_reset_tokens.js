/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumns('staff_user', {
    invite_token_hash:         { type: 'text' },
    invite_token_expires_at:   { type: 'timestamptz' },
    password_reset_token_hash:       { type: 'text' },
    password_reset_token_expires_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('staff_user', [
    'invite_token_hash',
    'invite_token_expires_at',
    'password_reset_token_hash',
    'password_reset_token_expires_at',
  ]);
};
