/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // OTP fields on client for phone-number login
  pgm.addColumns('client', {
    otp_hash:       { type: 'text' },
    otp_expires_at: { type: 'timestamptz' },
  });

  // Business slug for public portal URL (/book/:slug)
  pgm.addColumn('business', {
    slug: { type: 'text', unique: true },
  });

  // Seed slug from existing business names (lowercase, hyphenated, + short id suffix)
  pgm.sql(`
    UPDATE business
    SET slug = LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'))
              || '-' || SUBSTRING(id::text, 1, 6)
    WHERE slug IS NULL
  `);

  pgm.alterColumn('business', 'slug', { notNull: true });
};

exports.down = (pgm) => {
  pgm.dropColumn('business', 'slug');
  pgm.dropColumns('client', ['otp_hash', 'otp_expires_at']);
};
