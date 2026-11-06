import { describe, it, expect, vi } from 'vitest';
import { requestId } from '../../src/middlewares/requestId.js';

function fakeReq(inbound) {
  return { get: (name) => (name.toLowerCase() === 'x-request-id' ? inbound : undefined), app: {} };
}

describe('requestId middleware', () => {
  it('mints a UUID when no inbound id is present', () => {
    const req = fakeReq(undefined);
    const res = { setHeader: vi.fn() };
    const next = vi.fn();
    requestId(req, res, next);
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(next).toHaveBeenCalled();
  });

  it('honours a well-formed inbound id', () => {
    const req = fakeReq('req_abc-123.456');
    requestId(req, { setHeader: vi.fn() }, vi.fn());
    expect(req.id).toBe('req_abc-123.456');
  });

  it.each([
    ['CRLF injection', 'abc\nX-Injected: 1'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(200)],
    ['illegal characters', 'abc<script>alert(1)</script>'],
    ['empty string', ''],
  ])('rejects forged inbound id (%s) and mints a UUID', (_label, inbound) => {
    const req = fakeReq(inbound);
    requestId(req, { setHeader: vi.fn() }, vi.fn());
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.id).not.toBe(inbound);
  });
});
