import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Contact, contactsSince, parseContacts } from './dotslash-contacts.js';

const contact = (timestamp: string, email = 'sender@example.com'): Contact => ({
  email,
  message: 'Hi, I would like a quote',
  timestamp,
  ip: '203.0.113.7',
});

describe('parseContacts', () => {
  it('keeps a valid record as stored, extra fields and key order included', () => {
    const line =
      '{"timestamp":"2026-11-17T10:00:00Z","ip":"203.0.113.7","email":"a@b.c","message":"hi","userAgent":"curl"}';
    const { contacts, warnings } = parseContacts(line);
    expect(warnings).toEqual([]);
    expect(contacts).toHaveLength(1);
    expect(JSON.stringify(contacts[0])).toBe(line);
  });

  it('skips a record whose ip is not a string, and a line that is not JSON', () => {
    const valid = JSON.stringify(contact('2026-11-17T10:00:00Z'));
    const numericIp = JSON.stringify({ ...contact('2026-11-17T11:00:00Z'), ip: 2130706433 });
    const raw = [valid, 'not json {', numericIp, ''].join('\n');

    const { contacts, warnings } = parseContacts(raw);

    expect(contacts).toEqual([contact('2026-11-17T10:00:00Z')]);
    expect(warnings).toEqual([
      '[WARN] skipping a contacts.jsonl line that is not JSON',
      '[WARN] skipping a contact record without string email/message/timestamp/ip',
    ]);
  });

  it.each([
    ['timestamp', 5],
    ['email', null],
    ['message', undefined],
  ])('skips a record whose %s is not a string', (field, value) => {
    const line = JSON.stringify({ ...contact('2026-11-17T10:00:00Z'), [field]: value });
    expect(parseContacts(line).contacts).toEqual([]);
  });

  it('ignores blank lines and surrounding whitespace', () => {
    const line = JSON.stringify(contact('2026-11-17T10:00:00Z'));
    expect(parseContacts(`\n  ${line}  \n\n`)).toEqual({
      contacts: [contact('2026-11-17T10:00:00Z')],
      warnings: [],
    });
  });

  it('accounts for every non-blank line, and never echoes one in a warning', () => {
    const SKIP_WARNINGS = [
      '[WARN] skipping a contacts.jsonl line that is not JSON',
      '[WARN] skipping a contact record without string email/message/timestamp/ip',
    ];
    const line = fc.oneof(
      fc.string(),
      fc.emailAddress().map((email) => JSON.stringify({ email, message: 'hi', ip: 1 })),
      fc.emailAddress().map((email) => JSON.stringify(contact('2026-11-17T10:00:00Z', email))),
    );
    fc.assert(
      fc.property(fc.array(line), (lines) => {
        const { contacts, warnings } = parseContacts(lines.join('\n'));
        const nonBlank = lines
          .flatMap((l) => l.split('\n'))
          .filter((l) => l.trim().length > 0).length;
        expect(contacts.length + warnings.length).toBe(nonBlank);
        for (const warning of warnings) expect(SKIP_WARNINGS).toContain(warning);
      }),
    );
  });
});

describe('contactsSince', () => {
  it('returns the contacts after the cursor, oldest first, and advances the cursor to the newest', () => {
    const all = [
      contact('2026-11-17T12:00:00Z'),
      contact('2026-11-16T09:00:00Z'),
      contact('2026-11-17T08:00:00Z'),
    ];
    expect(contactsSince(all, '2026-11-17T00:00:00Z')).toEqual({
      fresh: [contact('2026-11-17T08:00:00Z'), contact('2026-11-17T12:00:00Z')],
      cursor: '2026-11-17T12:00:00Z',
    });
  });

  it('persists the newest valid timestamp even when the newest line is invalid', () => {
    const raw = [
      JSON.stringify(contact('2026-11-17T08:00:00Z')),
      JSON.stringify({ ...contact('2026-11-18T08:00:00Z'), ip: 7 }),
    ].join('\n');
    expect(contactsSince(parseContacts(raw).contacts, '2026-11-01T00:00:00Z').cursor).toBe(
      '2026-11-17T08:00:00Z',
    );
  });

  it('has no cursor when nothing is newer than it', () => {
    expect(contactsSince([contact('2026-11-01T00:00:00Z')], '2026-11-01T00:00:00Z')).toEqual({
      fresh: [],
      cursor: null,
    });
  });
});
