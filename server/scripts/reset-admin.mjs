/**
 * Development helper: resets the seeded administrator back to the documented
 * development credentials and re-arms the forced password rotation.
 *
 * Useful after trying the first-login flow (which rotates the password by design)
 * or when a demo environment needs a known state again. It never runs in
 * production: the guard below refuses to touch a `production` environment.
 *
 * Usage: node scripts/reset-admin.mjs [email] [password]
 */
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { User } from '../src/modules/auth/model.js';

if (env.isProduction) {
  throw new Error('Refusing to reset credentials in a production environment.');
}

const email = (process.argv[2] ?? 'admin@catalogue.com').toLowerCase();
const password = process.argv[3] ?? 'Admin123!';

await mongoose.connect(env.MONGO_URI);

const passwordHash = await bcrypt.hash(password, 12);
const user = await User.findOneAndUpdate(
  { email },
  {
    $set: {
      passwordHash,
      mustChangePassword: true,
      isActive: true,
      loginAttempts: 0,
      lockedUntil: null,
      tokenVersion: 0,
    },
  },
  { new: true },
);

process.stdout.write(
  user
    ? `Reset ${email} (role=${user.role}, mustChangePassword=true)\n`
    : `No user with email ${email}\n`,
);

await mongoose.disconnect();
