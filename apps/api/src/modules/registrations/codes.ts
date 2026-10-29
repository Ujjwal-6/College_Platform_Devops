import { createHash, randomBytes } from 'node:crypto';

// Letters and digits without I, L, O and U, so a code read aloud or copied by hand is hard to get wrong.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 16 characters x 5 bits = 80 bits of randomness (the requirement is at least 64). */
const CODE_LENGTH = 16;

/** A fresh random invitation code such as `7K2M-QX9D-4HT8-WB3N`. 256 is a multiple of 32, so every character is equally likely. */
export function generateInvitationCode(): string {
  const chars = Array.from(randomBytes(CODE_LENGTH), (b) => ALPHABET[b & 31]!).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/**
 * Accepts what a person might type: lower case, spaces or dashes, and I/L/O for 1/1/0. Returns null if
 * the text cannot be a code at all.
 */
export function normalizeInvitationCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export function hashInvitationCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
