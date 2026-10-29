import test from 'node:test';
import assert from 'node:assert/strict';
import * as oidc from 'openid-client';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createSso, ssoSettings } from '../src/sso.js';

test('SSO uses PKCE, state, nonce and signed identity validation; rejects altered claims and untrusted employee codes', async () => {
  const settings = ssoSettings({ KEYCLOAK_CLIENT_SECRET: 'test-secret' });
  assert.throws(() => ssoSettings({ KEYCLOAK_CLIENT_SECRET: 'test', APP_URL: 'http://example.com' }));
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let pending; let overrides = {}; let employee = '20260211'; let badSignature = false;
  let userSubject = 'person-1';
  const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const mockFetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('openid-configuration')) return json({ issuer: settings.issuer,
      authorization_endpoint: settings.issuer + '/auth', token_endpoint: settings.issuer + '/token',
      userinfo_endpoint: settings.issuer + '/userinfo', jwks_uri: settings.issuer + '/certs',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    if (path.endsWith('/certs')) return json({ keys: [publicJwk] });
    if (path.endsWith('/token')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code_verifier'), pending.data.verifier);
      assert.equal(body.get('redirect_uri'), settings.callback);
      const now = Math.floor(Date.now() / 1000);
      let token = await new SignJWT({ iss: settings.issuer, aud: 'sms', sub: 'person-1', iat: now, exp: now + 300, nonce: pending.data.nonce, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
      if (badSignature) { const parts = token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1); token = parts.join('.'); }
      return json({ access_token: 'test-access', token_type: 'Bearer', id_token: token });
    }
    if (path.endsWith('/userinfo')) return json({ sub: userSubject, idcode: employee, name: 'Test Admin' });
    throw new Error('Unexpected endpoint');
  };
  const sso = createSso(settings, { [oidc.customFetch]: mockFetch });
  async function attempt(state) {
    pending = await sso.begin();
    const authorization = new URL(pending.url);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('scope'), 'openid profile email');
    return sso.complete(new URL(settings.callback + '?code=test&state=' + (state ?? pending.data.state)), pending.data);
  }
  assert.equal((await attempt()).idcode, '20260211');
  await assert.rejects(attempt('wrong-state'));
  for (const invalid of [{ aud: 'other-client' }, { iss: 'https://evil.example' }, { exp: 1 }, { nonce: 'wrong-nonce' }]) {
    overrides = invalid; await assert.rejects(attempt());
  }
  overrides = {}; badSignature = true; await assert.rejects(attempt()); badSignature = false;
  for (const invalid of [null, ['20260211'], ' 20260211', '20260211 ']) { employee = invalid; await assert.rejects(attempt()); }
  employee = '20260211'; userSubject = 'someone-else'; await assert.rejects(attempt());
});
