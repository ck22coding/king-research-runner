// In-memory PostgREST-shaped stub server for tests that need markets/
// enrichment_jobs/facts/sources (and whatever else index.mjs happens to hit
// along the way — runner_heartbeats, companies) without a live/hosted
// Supabase project. Generalizes startup.test.mjs's startDeniedPollSupabase():
// same auth-stub shape, same createServer-on-127.0.0.1-port-0 pattern, but a
// real (schema-less) table store behind /rest/v1/<table> instead of one
// hand-coded route, since task 5/6 need markets AND enrichment_jobs AND facts
// AND sources AND a storage upload, all against the one real index.mjs.
//
// Scope is deliberately the subset of the supabase-js wire format index.mjs
// actually sends (confirmed by reading index.mjs, not guessed): GET with
// .eq/.in/.order/.limit/.or filters and .single()'s Accept header, PATCH
// (conditional update, optional `?select=` representation), POST (insert,
// optional representation) — no DELETE, no real upsert-merge semantics (the
// one .upsert() call in index.mjs, the heartbeat presence row, already
// treats a write failure as non-fatal, so being treated as a plain insert
// here is harmless — ponytail: add real on_conflict merging if a test ever
// asserts on runner_heartbeats).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function coerce(raw) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

// Splits "eq.5" / "in.(1,2)" / "is.null" / "lt.2026-01-01T00:00:00.000Z" on
// the FIRST dot only — timestamps contain dots (fractional seconds), so a
// naive split(',') on every dot corrupts them.
function parseOpVal(raw) {
  const dot = raw.indexOf('.');
  return { op: raw.slice(0, dot), val: raw.slice(dot + 1) };
}

function matchOp(row, col, op, rawVal) {
  const actual = row[col];
  if (op === 'in') {
    const list = rawVal
      .replace(/^\(|\)$/g, '')
      .split(',')
      .map((s) => s.replace(/^"|"$/g, ''));
    return list.includes(String(actual));
  }
  if (op === 'is') return actual === coerce(rawVal);
  const val = coerce(rawVal);
  switch (op) {
    case 'eq': return String(actual) === String(val);
    case 'neq': return String(actual) !== String(val);
    case 'lt': return actual < val;
    case 'lte': return actual <= val;
    case 'gt': return actual > val;
    case 'gte': return actual >= val;
    // ponytail: unknown operator passes every row rather than throwing —
    // extend matchOp when index.mjs starts sending one this doesn't cover.
    default: return true;
  }
}

// `.or('heartbeat_at.is.null,heartbeat_at.lt.<iso>')` arrives on the wire as
// `or=(col.op.val,col.op.val)` — one level of grouping, no nesting, since
// that's all the crash-recovery query (the only .or() call in index.mjs)
// ever sends.
function parseOrGroup(raw) {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
  return inner.split(',').map((cond) => {
    const firstDot = cond.indexOf('.');
    const col = cond.slice(0, firstDot);
    const { op, val } = parseOpVal(cond.slice(firstDot + 1));
    return { col, op, val };
  });
}

function applyFilters(rows, searchParams) {
  let result = rows;
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
    if (key === 'or') {
      const group = parseOrGroup(value);
      result = result.filter((row) => group.some(({ col, op, val }) => matchOp(row, col, op, val)));
      continue;
    }
    const { op, val } = parseOpVal(value);
    result = result.filter((row) => matchOp(row, key, op, val));
  }
  const order = searchParams.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    const mult = dir === 'desc' ? -1 : 1;
    result = [...result].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * mult);
  }
  const limit = searchParams.get('limit');
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

const SINGLE_ACCEPT = 'application/vnd.pgrst.object+json';

export function startStubSupabase({ userId = randomUUID(), email = 'stub-user@runner-test.example' } = {}) {
  const tables = new Map();
  const objects = new Map(); // "bucket/path" -> Buffer, for the storage upload stub

  function table(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} };
  const session = {
    // Shaped like a real JWT (supabase-js reads the payload client-side),
    // never actually verified — same trick as startup.test.mjs's stub.
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, email, role: 'authenticated', aud: 'authenticated', exp })}.stub`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: 'stub-refresh-token',
    user,
  };

  function json(res, status, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://stub');

      if (url.pathname.startsWith('/auth/v1/token')) {
        await readBody(req);
        return json(res, 200, session);
      }
      if (url.pathname.startsWith('/auth/v1/user')) {
        req.resume();
        return json(res, 200, user);
      }
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
        if (req.method === 'POST' || req.method === 'PUT') {
          objects.set(key, await readBody(req));
          return json(res, 200, { Key: key, Id: randomUUID() });
        }
        req.resume();
        return json(res, 404, { message: `stub: unsupported storage method ${req.method}` });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const tableName = url.pathname.slice('/rest/v1/'.length);
        const rows = table(tableName);
        const wantsSingle = req.headers.accept === SINGLE_ACCEPT;

        if (req.method === 'GET' || req.method === 'HEAD') {
          req.resume();
          const matched = applyFilters(rows, url.searchParams);
          if (wantsSingle) {
            if (matched.length !== 1) {
              return json(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
            }
            return json(res, 200, matched[0]);
          }
          return json(res, 200, matched);
        }

        if (req.method === 'PATCH') {
          const raw = (await readBody(req)).toString('utf8');
          const patch = raw ? JSON.parse(raw) : {};
          const matched = applyFilters(rows, url.searchParams);
          for (const row of matched) Object.assign(row, patch);
          const wantsRepresentation = (req.headers['prefer'] || '').includes('return=representation');
          if (!wantsRepresentation) { res.writeHead(204); return res.end(); }
          if (wantsSingle) {
            if (matched.length !== 1) {
              return json(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
            }
            return json(res, 200, matched[0]);
          }
          return json(res, 200, matched);
        }

        if (req.method === 'POST') {
          const raw = (await readBody(req)).toString('utf8');
          const parsed = raw ? JSON.parse(raw) : {};
          const incoming = Array.isArray(parsed) ? parsed : [parsed];
          const inserted = incoming.map((r) => ({ id: randomUUID(), ...r }));
          rows.push(...inserted);
          const wantsRepresentation = (req.headers['prefer'] || '').includes('return=representation');
          if (!wantsRepresentation) { res.writeHead(201); return res.end(); }
          if (wantsSingle) {
            if (inserted.length !== 1) {
              return json(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
            }
            return json(res, 201, inserted[0]);
          }
          return json(res, 201, inserted);
        }

        req.resume();
        return json(res, 405, { message: `stub: unsupported method ${req.method} on ${tableName}` });
      }

      req.resume();
      return json(res, 404, { message: `stub: unhandled path ${url.pathname}` });
    } catch (err) {
      json(res, 500, { message: `stub error: ${err.message}` });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        userId,
        email,
        // Live array reference — tests/tasks seed or inspect a table directly
        // (e.g. stub.table('markets').push({ id, ... })) without going
        // through HTTP.
        table,
        // "bucket/path" -> Buffer, for asserting what the generate job's
        // deck upload actually wrote.
        objects,
        // Same shape writeCredsFor(session, credPath) in helpers.mjs
        // produces, so a spawned runner can start already-paired against
        // this stub instead of prompting for a pairing code.
        writeCreds(credPath) {
          writeFileSync(credPath, JSON.stringify({ refresh_token: session.refresh_token }), { mode: 0o600 });
        },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
      });
    });
  });
}
