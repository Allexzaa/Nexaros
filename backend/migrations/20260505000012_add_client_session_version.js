/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('client', {
    session_version: { type: 'integer', notNull: true, default: 1 },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('client', 'session_version');
};
