import { PutRewardApiRequest } from './identity';

/*
 * Final review (questions 5 and 6): the body of `PUT /v1/operator/integrations/:casino/reward-api`.
 *
 * REWARD-URL-1 (RED at a4d97bb): the URL check is the scheme only. A literal loopback, private,
 * link-local (cloud metadata), IPv4-mapped or numeric-encoded address, and a URL that carries
 * credentials, are accepted and stored. This is the PUT-time half; the call-time half (names that
 * resolve to such addresses, redirects) is review-final-ssrf.test.ts in engagement.
 * Mutation for the fix: drop the address refinement -> REWARD-URL-1 red.
 *
 * REWARD-ENV-1 (RED at a4d97bb): `environment` defaults to `production`. A PUT meant for the
 * sandbox endpoint that forgets the field overwrites the PRODUCTION reward API (the upsert key is
 * tenant + casino + environment), and production issuance then goes to the sandbox casino.
 * D-28: the environment is never taken from a default. Mutation for the fix: restore the default.
 */

const ok = { environment: 'production', base_url: 'https://rewards.casino.example/v1' };

describe('final review: the reward API body', () => {
  it('REWARD-URL-1 refuses literal internal addresses and URLs with credentials', () => {
    expect(PutRewardApiRequest.safeParse(ok).success).toBe(true);
    const refused = [
      'http://169.254.169.254/latest/meta-data/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://127.0.0.1:4003/internal/v1/tenants',
      'http://localhost:4001/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://0.0.0.0/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'https://user:secret@rewards.casino.example/v1',
    ];
    const accepted = refused.filter(
      (base_url) => PutRewardApiRequest.safeParse({ ...ok, base_url }).success,
    );
    expect(accepted).toEqual([]);
  });

  it('REWARD-ENV-1 the environment is required, never a default', () => {
    expect(PutRewardApiRequest.safeParse({ base_url: ok.base_url }).success).toBe(false);
  });
});
