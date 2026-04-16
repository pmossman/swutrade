import { config } from 'dotenv';
config({ path: '.env.local' });

import { seedTestUser } from './seed.js';

export default async function globalSetup() {
  await seedTestUser();
}
