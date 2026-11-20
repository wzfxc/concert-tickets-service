import { describe, expect, it } from 'vitest';
import { normalizeIp } from '../../apps/api/src/common/rate-limit.ts';

describe('normalizeIp', () => {
  it('keys IPv4 in every IPv6 spelling by the embedded IPv4, never by a shared prefix', () => {
    for (const a of [
      '::ffff:1.2.3.4',
      '::ffff:102:304',
      '0:0:0:0:0:ffff:102:304',
      '::1.2.3.4',
      '64:ff9b::1.2.3.4',
      '64:ff9b::102:304',
    ]) {
      expect(normalizeIp(a), a).toBe('1.2.3.4');
    }
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
  });
  it('keys native IPv6 by /64 and keeps loopback and garbage distinct', () => {
    expect(normalizeIp('2001:db8:1:2::1')).toBe(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    expect(normalizeIp('2001:db8:1:3::1')).not.toBe(normalizeIp('2001:db8:1:2::1'));
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeIp('not-an-ip')).toBe('not-an-ip');
  });
});
