import path from 'path';
import dotenv from 'dotenv';

// TEST_ENV=qa loads .env.qa first; .env fills anything it leaves unset.
const root = path.resolve(__dirname, '../..');
if (process.env.TEST_ENV) {
  dotenv.config({ path: path.join(root, `.env.${process.env.TEST_ENV}`) });
}
dotenv.config({ path: path.join(root, '.env') });

export function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}
