import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('admin pages enforce SSO allowlist, CSRF, session revocation and restricted API tokens without exposing SMS logs', async t => {
  const sessions = new Map();
  const admins = new Map([['20260211', { idcode: '20260211', active: true }]]);
  const tokens = new Map();
  let identity = { idcode: '20260211', issuer: 'https://sso.example', subject: 'first-user', name: '<Admin>' };
  const adminStore = {
    async session(id) { const data = sessions.get(id); return data && (!data.idcode || admins.get(data.idcode)?.active) ? data : undefined; },
    async saveSession(id, data) { sessions.set(id, data); }, async deleteSession(id) { sessions.delete(id); },
    async consumeSession(id) { const data = sessions.get(id); sessions.delete(id); return data?.state ? data : undefined; },
    async login(code, issuer, subject, name) {
      const admin = admins.get(code);
      if (!admin?.active || (admin.subject && admin.subject !== subject)) return;
      Object.assign(admin, { subject, display_name: name }); return admin;
    },
    async admins() { return [...admins.values()]; },
    async addAdmin(code) { admins.set(code, { idcode: code, active: true }); },
    async revokeAdmin(code, actor) { if (code === actor) throw Object.assign(new Error('You cannot revoke your own access.'), { status: 400 }); admins.get(code).active = false; },
    async status() { return { queued: 5, sent: 10 }; },
    async tokens() { return [...tokens.values()].map(({ secret, ...row }) => row); },
    async createToken(name, expires, actor) {
      const row = { id: '11111111-1111-1111-1111-111111111111', secret: 'sms_' + 'b'.repeat(64), name, expires_at: expires, created_by: actor };
      tokens.set(row.id, row); return row;
    },
    async revokeToken(id) { tokens.get(id).revoked_at = new Date(); },
    async authenticateToken(secret) { return [...tokens.values()].some(row => row.secret === secret && !row.revoked_at); }
  };
  const smsStore = { async ping() {}, async recover() {}, async expire() {},
    async devices() { return [{ id: 'tablet-1', name: '<device>', recipient: '+639999999999', body: 'Private SMS content' }]; },
    async get() { return { id: 'sms-1', status: 'sent' }; },
    async enqueue(input) { return { created: true, message: { id: 'sms-1', status: 'queued', recipient: input.to, body: input.body } }; }
  };
  const settings = { origin: 'http://127.0.0.1:3000', secure: false };
  const app = await createServer({ apiToken: 'a'.repeat(32), store: smsStore, adminStore, webSettings: settings,
    sso: { async begin() { return { url: 'https://sso.example/auth', data: { state: 'state' } }; }, async complete() { return identity; } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const post = (path, body, cookie, origin = settings.origin) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const cookie = response => response.headers.get('set-cookie').split(';')[0];
  async function login() {
    const begin = await get('/auth/keycloak/redirect');
    return get('/auth/keycloak/callback?code=test&state=state', cookie(begin));
  }
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/dashboard')).headers.get('location'), '/login');
  identity.idcode = 'not-approved'; assert.equal((await login()).status, 403);
  identity.idcode = '20260211';
  const loggedIn = await login(); assert.equal(loggedIn.status, 303);
  const adminCookie = cookie(loggedIn);
  const sid = adminCookie.split('=')[1];
  const csrf = sessions.get(sid).csrf;
  const overview = await get('/dashboard', adminCookie);
  const overviewHtml = await overview.text();
  assert.match(overviewHtml, /&lt;device&gt;/);
  assert.doesNotMatch(overviewHtml, /Private SMS content|639999999999|<Admin>/);
  assert.match(overview.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await get('/login', adminCookie)).headers.get('location'), '/dashboard');
  assert.equal((await post('/dashboard/tokens', { action: 'create', name: 'Orders', days: '30' }, adminCookie)).status, 403);
  assert.equal((await post('/dashboard/tokens', { csrf, action: 'create', name: 'Orders', days: '30' }, adminCookie, 'https://evil.example')).status, 403);
  const created = await post('/dashboard/tokens', { csrf, action: 'create', name: '<Orders>', days: '30' }, adminCookie);
  assert.equal(created.status, 201);
  const secret = [...tokens.values()][0].secret;
  assert.match(await created.text(), new RegExp(secret));
  assert.doesNotMatch(await (await get('/dashboard/tokens', adminCookie)).text(), new RegExp(secret));
  const api = (path, token, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const payload = { requestId: 'test', to: '+639171234567', body: 'Test' };
  assert.equal((await api('/sms', secret, payload)).status, 202);
  assert.equal((await api('/sms/sms-1', secret)).status, 200);
  assert.equal((await api('/devices', secret)).status, 401);
  assert.equal((await api('/sms', 'a'.repeat(32), payload)).status, 202);
  await post('/dashboard/tokens', { csrf, action: 'revoke', id: [...tokens.keys()][0] }, adminCookie);
  assert.equal((await api('/sms', secret, payload)).status, 401);
  assert.equal((await post('/dashboard/admins', { csrf, action: 'revoke', idcode: '20260211' }, adminCookie)).status, 400);
  await post('/dashboard/admins', { csrf, action: 'add', idcode: '000234' }, adminCookie);
  assert.equal(admins.get('000234').active, true);
  identity = { ...identity, idcode: '000234', subject: 'second-user' };
  const second = cookie(await login());
  await post('/dashboard/admins', { csrf, action: 'revoke', idcode: '000234' }, adminCookie);
  assert.equal((await get('/dashboard', second)).headers.get('location'), '/login');
  const start = await get('/auth/keycloak/redirect');
  const loginCookie = cookie(start);
  await get('/auth/keycloak/callback?code=test', loginCookie);
  assert.equal((await get('/auth/keycloak/callback?code=test', loginCookie)).status, 400);
  await post('/auth/keycloak/logout', { csrf }, adminCookie);
  assert.equal((await get('/dashboard', adminCookie)).headers.get('location'), '/login');
});
