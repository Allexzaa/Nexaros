/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE waitlist_entry DROP CONSTRAINT IF EXISTS waitlist_entry_status_check`);
  pgm.sql(`ALTER TABLE waitlist_entry ADD CONSTRAINT waitlist_entry_status_check CHECK (status IN ('waiting', 'notified', 'scheduled', 'expired'))`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE waitlist_entry DROP CONSTRAINT IF EXISTS waitlist_entry_status_check`);
  pgm.sql(`ALTER TABLE waitlist_entry ADD CONSTRAINT waitlist_entry_status_check CHECK (status IN ('waiting', 'notified', 'scheduled'))`);
};
