import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin-only diagnostic: shows which Smartflo email is configured and password length (no plaintext).


export default async function checkSmartfloCreds(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const email = Deno.env.get('SMARTFLO_EMAIL') || '';
    const password = Deno.env.get('SMARTFLO_PASSWORD') || '';

    return c.json({ data: {
      smartflo_email: email,
      password_length: password.length,
      password_first_char: password ? password[0] : null,
      password_last_char: password ? password[password.length - 1] : null,
      password_has_leading_space: password !== password.trimStart(),
      password_has_trailing_space: password !== password.trimEnd(),
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};