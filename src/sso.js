import * as oidc from 'openid-client';

export function ssoSettings(env = process.env) {
  const origin = new URL(env.APP_URL || 'https://sms.jathnier.com');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) {
    throw new Error('APP_URL must be an HTTPS origin (HTTP is allowed only for local development)');
  }
  const issuer = new URL(`${(env.KEYCLOAK_BASE_URL || 'https://sso.rosebakeshop.net').replace(/\/$/, '')}/realms/${env.KEYCLOAK_REALM || 'jathnier'}`);
  if (issuer.protocol !== 'https:') throw new Error('Keycloak requires HTTPS');
  if (!env.KEYCLOAK_CLIENT_SECRET) throw new Error('KEYCLOAK_CLIENT_SECRET is required');
  return { origin: origin.origin, secure: origin.protocol === 'https:', issuer: issuer.href,
    clientId: env.KEYCLOAK_CLIENT_ID || 'sms', secret: env.KEYCLOAK_CLIENT_SECRET,
    callback: origin.origin + '/auth/keycloak/callback' };
}

export function createSso(settings, discoveryOptions) {
  let configuration;
  const config = async () => {
    // Cache successful discovery; allow a later retry after a provider outage.
    if (!configuration) configuration = oidc.discovery(new URL(settings.issuer), settings.clientId, settings.secret, undefined, discoveryOptions)
      .then(result => { oidc.enableNonRepudiationChecks(result); return result; })
      .catch(error => { configuration = undefined; throw error; });
    return configuration;
  };
  return {
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(await config(), { redirect_uri: settings.callback,
        scope: 'openid profile email', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      return { url: url.href, data: { verifier, state, nonce } };
    },
    async complete(url, data) {
      const configuration = await config();
      const tokens = await oidc.authorizationCodeGrant(configuration, url, { pkceCodeVerifier: data.verifier,
        expectedState: data.state, expectedNonce: data.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      const info = await oidc.fetchUserInfo(configuration, tokens.access_token, claims.sub);
      if (typeof info.idcode !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(info.idcode)) throw new Error('Missing employee idcode');
      return { idcode: info.idcode, issuer: settings.issuer, subject: claims.sub,
        name: String(info.name || info.preferred_username || info.idcode).slice(0, 200) };
    }
  };
}
