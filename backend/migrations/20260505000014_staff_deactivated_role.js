/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE staff_user DROP CONSTRAINT IF EXISTS staff_user_role_check`);
  pgm.sql(`ALTER TABLE staff_user ADD CONSTRAINT staff_user_role_check CHECK (role IN ('admin', 'staff', 'viewer', 'deactivated'))`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE staff_user DROP CONSTRAINT IF EXISTS staff_user_role_check`);
  pgm.sql(`ALTER TABLE staff_user ADD CONSTRAINT staff_user_role_check CHECK (role IN ('admin', 'staff', 'viewer'))`);
};
