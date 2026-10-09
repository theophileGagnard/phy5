// community.js -- presets partagés : un preset par compte (nom d'utilisateur + mot de passe), lisibles par tous.
// Base Supabase (voir Web/demo/community/supabase.sql) appelée directement par son API REST, sans bibliothèque.
// La clé « publishable » est publique par nature : ce sont les règles de la table (RLS) qui protègent les données.
// Sur un hébergement qui bloque ces appels (page claude.ai), available() renvoie false et la page masque la fonction.

const URL_BASE = 'https://ddvzqwmqmbssngcmbirw.supabase.co';
const KEY = 'sb_publishable_Xf2BbNPX8wzwldHyDLUafg_EI_0nXQq';
const EMAIL_DOMAIN = 'players.theophilegagnard.com';   // adresse interne, jamais utilisée pour écrire
const TABLE = `${URL_BASE}/rest/v1/community_presets`;
const STORE_KEY = 'rezo-community-session';

export const USERNAME_RULE = /^[a-z0-9_-]{3,20}$/;

let session = null;   // { access_token, refresh_token, expires_at (s), username }
try { session = JSON.parse (localStorage.getItem (STORE_KEY) ?? 'null'); } catch { session = null; }

function saveSession (s)
{
    session = s;
    try { s ? localStorage.setItem (STORE_KEY, JSON.stringify (s)) : localStorage.removeItem (STORE_KEY); } catch { /* session pour cette visite seulement */ }
}

async function call (url, { method = 'GET', body, auth = false, headers = {} } = {})
{
    const h = { apikey: KEY, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = `Bearer ${await accessToken()}`;
    const r = await fetch (url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify (body) });
    const text = await r.text();
    const data = text ? JSON.parse (text) : null;
    if (! r.ok) throw new Error (message (data, r.status));
    return data;
}

// messages d'erreur de Supabase -> phrases pour la page
function message (data, status)
{
    const raw = data?.msg ?? data?.message ?? data?.error_description ?? data?.error ?? `HTTP ${status}`;
    if (/already registered|already exists/i.test (raw)) return 'This username is already taken.';
    if (/invalid login credentials/i.test (raw)) return 'Wrong username or password.';
    if (/password/i.test (raw) && /at least|short|weak/i.test (raw)) return 'The password is too short (6 characters minimum).';
    if (/rate limit|too many/i.test (raw)) return 'Too many attempts. Please wait a few minutes.';
    return raw;
}

const emailOf = (username) => `${username}@${EMAIL_DOMAIN}`;

function fromAuth (data, username)
{
    if (! data?.access_token) throw new Error ('The account was created but needs a confirmation the demo cannot do. Please tell the site owner.');
    saveSession ({ access_token: data.access_token, refresh_token: data.refresh_token,
                   expires_at: Math.floor (Date.now() / 1000) + (data.expires_in ?? 3600), username });
}

async function accessToken()
{
    if (! session) throw new Error ('Not signed in.');
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    try
    {
        const data = await fetch (`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify ({ refresh_token: session.refresh_token }) }).then (r => r.ok ? r.json() : null);
        fromAuth (data, session.username);
        return session.access_token;
    }
    catch { saveSession (null); throw new Error ('Your session has expired. Please log in again.'); }
}

// ---------------------------------------------------------------- API de la page
export const currentUser = () => session?.username ?? null;

// la base répond-elle ? (sinon : fonction masquée)
export async function available()
{
    try { await call (`${TABLE}?select=user_id&limit=1`); return true; }
    catch { return false; }
}

export async function signUp (username, password)
{
    const data = await call (`${URL_BASE}/auth/v1/signup`, { method: 'POST', body: { email: emailOf (username), password, data: { username } } });
    fromAuth (data, username);
}

export async function logIn (username, password)
{
    const data = await call (`${URL_BASE}/auth/v1/token?grant_type=password`, { method: 'POST', body: { email: emailOf (username), password } });
    fromAuth (data, username);
}

export function logOut()
{
    const token = session?.access_token;
    saveSession (null);
    if (token) fetch (`${URL_BASE}/auth/v1/logout`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}` } }).catch (() => {});
}

// tous les presets partagés : [{ user_id, username, name, preset, updated_at }], du plus récent au plus ancien
export const list = () => call (`${TABLE}?select=user_id,username,name,preset,updated_at&order=updated_at.desc&limit=500`);

// le preset du compte connecté (ou null)
export async function mine()
{
    const rows = await call (`${TABLE}?select=name,updated_at&user_id=eq.${encodeURIComponent (await userId())}`, { auth: true });
    return rows?.[0] ?? null;
}

// enregistre (ou remplace) LE preset du compte connecté
export const save = (name, preset) => call (`${TABLE}?on_conflict=user_id`, {
    method: 'POST', auth: true, body: { name, preset },
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });

export async function remove()
{
    await call (`${TABLE}?user_id=eq.${encodeURIComponent (await userId())}`, { method: 'DELETE', auth: true });
}

async function userId()
{
    const token = await accessToken();
    return JSON.parse (atob (token.split ('.')[1].replace (/-/g, '+').replace (/_/g, '/'))).sub;
}
