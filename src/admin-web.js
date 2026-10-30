import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { renderPage } from './admin-views.js';

const random = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const idcodePattern = /^[A-Za-z0-9_-]{1,100}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;

function cookieValue(request, name) {
  return (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
}

async function readForm(request) {
  if (!String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded')) throw Object.assign(new Error('Unsupported form format.'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('Form is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createAdminWeb({ store, sso, settings, getDevices }) {
  const cookieName = settings.secure ? '__Host-rose_sms' : 'rose_sms_local';
  const setCookie = (response, value, seconds) => response.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${settings.secure ? '; Secure' : ''}`);
  const redirect = (response, path) => { response.writeHead(303, { Location: path }); response.end(); };
  function html(response, status, page, data) {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderPage(page, data));
  }
  return async (request, response) => {
    const url = new URL(request.url, settings.origin);
    const path = url.pathname;
    if (!['/', '/login', '/auth/keycloak/redirect', '/auth/keycloak/callback', '/auth/keycloak/logout', '/dashboard', '/dashboard/tokens', '/dashboard/admins', '/assets/admin.css', '/assets/admin.js', '/assets/rose-logo.png', '/assets/Courgette-Regular.ttf', '/assets/Outfit-Variable.ttf'].includes(path)) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    let session;
    try {
      if (path.startsWith('/assets/')) {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return true; }
        const assets = {
          '/assets/admin.css': ['admin.css', 'text/css; charset=utf-8'],
          '/assets/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
          '/assets/rose-logo.png': ['rose-logo.png', 'image/png'],
          '/assets/Courgette-Regular.ttf': ['fonts/Courgette-Regular.ttf', 'font/ttf'],
          '/assets/Outfit-Variable.ttf': ['fonts/Outfit-Variable.ttf', 'font/ttf']
        };
        const [file, contentType] = assets[path];
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(await readFile(new URL('../public/' + file, import.meta.url)));
        return true;
      }
      const sid = cookieValue(request, cookieName);
      session = sid && /^[a-f0-9]{64}$/.test(sid) ? await store.session(sid) : undefined;
      const authenticated = session?.idcode;
      if (request.method === 'GET') {
        if (path === '/') html(response, 200, 'home', { session });
        else if (path === '/login') {
          if (authenticated) redirect(response, '/dashboard');
          else html(response, 200, 'login', {});
        } else if (path === '/auth/keycloak/redirect') {
          if (authenticated) { redirect(response, '/dashboard'); return true; }
          const pending = await sso.begin();
          if (sid) await store.deleteSession(sid);
          const id = random();
          await store.saveSession(id, pending.data, new Date(Date.now() + 600000));
          setCookie(response, id, 600);
          redirect(response, pending.url);
        } else if (path === '/auth/keycloak/callback') {
          // Consume before exchanging the code: a callback cannot be replayed.
          const pending = sid ? await store.consumeSession(sid) : undefined;
          if (!pending?.state) throw Object.assign(new Error('Sign-in expired. Please try again.'), { status: 400 });
          const identity = await sso.complete(url, pending);
          const admin = await store.login(identity.idcode, identity.issuer, identity.subject, identity.name);
          if (!admin) throw Object.assign(new Error('Your Rose Account does not have administrator access.'), { status: 403 });
          const id = random();
          await store.saveSession(id, { idcode: admin.idcode, name: admin.display_name || identity.name, csrf: random() }, new Date(Date.now() + 8 * 3600000));
          setCookie(response, id, 8 * 3600);
          redirect(response, '/dashboard');
        } else if (path.startsWith('/dashboard')) {
          if (!authenticated) { redirect(response, '/login'); return true; }
          const data = { session };
          if (path === '/dashboard') { data.counts = await store.status(); data.devices = await getDevices(); }
          if (path === '/dashboard/tokens') data.tokens = await store.tokens();
          if (path === '/dashboard/admins') data.admins = await store.admins();
          html(response, 200, path.slice(11) || 'dashboard', data);
        } else { response.writeHead(405); response.end(); }
      } else if (request.method === 'POST' && ['/dashboard/tokens', '/dashboard/admins', '/auth/keycloak/logout'].includes(path)) {
        if (!authenticated) { html(response, 401, 'error', { message: 'Sign in before continuing.' }); return true; }
        const form = await readForm(request);
        if (request.headers.origin !== settings.origin || !equal(form.get('csrf'), session.csrf)) throw Object.assign(new Error('The form expired. Reload the page and try again.'), { status: 403 });
        if (path === '/auth/keycloak/logout') {
          await store.deleteSession(sid);
          setCookie(response, '', 0);
          redirect(response, '/login');
        } else if (path === '/dashboard/admins') {
          const idcode = form.get('idcode') || '';
          if (!idcodePattern.test(idcode)) throw Object.assign(new Error('Enter an employee code of 1–100 letters, digits, underscores or hyphens.'), { status: 400 });
          if (form.get('action') === 'add') await store.addAdmin(idcode);
          else if (form.get('action') === 'revoke') await store.revokeAdmin(idcode, session.idcode);
          else throw Object.assign(new Error('Unknown action.'), { status: 400 });
          redirect(response, path);
        } else {
          if (form.get('action') === 'revoke') {
            if (!uuidPattern.test(form.get('id') || '')) throw Object.assign(new Error('Invalid token.'), { status: 400 });
            await store.revokeToken(form.get('id'));
            redirect(response, path);
          } else if (form.get('action') === 'create') {
            const name = (form.get('name') || '').trim();
            const days = form.get('days');
            if (!name || name.length > 100 || !['0', '7', '30', '90', '365'].includes(days)) throw Object.assign(new Error('Enter a name and choose a valid expiration.'), { status: 400 });
            const expires = days === '0' ? null : new Date(Date.now() + Number(days) * 86400000);
            const result = await store.createToken(name, expires, session.idcode);
            html(response, 201, 'created', { session, secret: result.secret, name });
          } else throw Object.assign(new Error('Unknown action.'), { status: 400 });
        }
      } else { response.writeHead(405); response.end(); }
    } catch (error) {
      // Provider errors may contain credentials or token responses. Never log them.
      html(response, error.status || 503, 'error', { session, message: error.status ? error.message : 'The service could not complete this request. Please try again.' });
    }
    return true;
  };
}
