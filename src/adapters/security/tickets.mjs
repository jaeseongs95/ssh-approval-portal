import { timingSafeEqual, createHmac } from 'node:crypto';

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const authenticated = (req, secret) => equalSecret(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], secret);

export class Tickets {
  constructor(key, now = () => Date.now()) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw Error('UI ticket key must be 32 bytes encoded as hex');
    this.key = key; this.now = now;
  }
  issue(purpose, subject, expiresAt) {
    const body = Buffer.from(JSON.stringify({ purpose, subject, expiresAt })).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }
  verify(ticket, purpose, subject) {
    if (typeof ticket !== 'string' || ticket.length > 8192) throw Error('Invalid ticket');
    const [body, signature, extra] = ticket.split('.');
    const expected = createHmac('sha256', this.key).update(body ?? '').digest('base64url');
    if (extra || !equalSecret(signature, expected)) throw Error('Invalid ticket');
    let value; try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw Error('Invalid ticket'); }
    if (value.purpose !== purpose || value.subject !== subject || !Number.isSafeInteger(value.expiresAt) || this.now() >= value.expiresAt) throw Error('Expired or mismatched ticket');
    return value;
  }
}
