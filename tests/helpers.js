import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const MIGS = ['0001_core.sql', '0004_players_list.sql', '0006_join_notice.sql', '0007_claim_outbox.sql', '0008_ranking.sql', '0009_no_confirm.sql', '0010_ranking_final.sql', '0011_auto_draw.sql', '0012_editions.sql'].map(f => path.resolve(import.meta.dirname, '../supabase/migrations/' + f));
const PORT = 54329;
let server, dir, base, counter = 0;

const STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create extension pgcrypto schema extensions;
  grant usage on schema public, auth, extensions to anon, authenticated;
`;

const client = async (database) => {
  const c = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database });
  await c.connect();
  return c;
};

export async function startServer() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nov-pg-'));
  server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await server.initialise();
  await server.start();
  const c = await client('postgres');
  await c.query('create database base');
  await c.end();
  base = await client('base');
  await base.query(STUBS);
  for (const m of MIGS) await base.query(fs.readFileSync(m, 'utf8'));
  await base.end();
}

export async function stopServer() { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }

// Una base de datos limpia por prueba.
export async function freshDb() {
  const name = 't' + (++counter);
  const c = await client('postgres');
  await c.query(`create database ${name} template base`);
  await c.end();
  const db = await client(name);
  // Partida abierta: empezó hace 1 h y acaba en 30 días.
  await db.query(`update game_config set test_mode = true, start_at = now() - interval '1 hour',
    end_at = now() + interval '30 days', dispute_end_at = now() + interval '37 days'`);
  const api = {
    db,
    users: {},
    sql: (q, p) => db.query(q, p),
    // Ejecuta una llamada como un jugador autenticado (rol authenticated + JWT sub).
    async as(user, q, p) {
      const id = typeof user === 'string' ? user : user.id;
      await db.query('begin');
      try {
        await db.query('set local role authenticated');
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id]);
        const r = await db.query(q, p);
        await db.query('commit');
        return r;
      } catch (e) { await db.query('rollback'); throw e; }
    },
    async rpc(user, fn, ...args) {
      const ph = args.map((_, i) => '$' + (i + 1)).join(',');
      const r = await api.as(user, `select public.${fn}(${ph}) as r`, args);
      return r.rows[0].r;
    },
    // Crea la cuenta de Auth y pide unirse.
    async join(name) {
      const id = randomUUID();
      const key = (await db.query('select public.name_key_of($1) k', [name])).rows[0].k;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, key + '@noviembrada.local']);
      const res = await api.rpc(id, 'request_join', name, true, true, true);
      return { id, name, res };
    },
    async close() { await db.end(); },
  };
  return api;
}

export const rejects = async (p, msg) => {
  try { await p; } catch (e) {
    if (!e.message.includes(msg)) throw new Error(`esperaba «${msg}», llegó «${e.message}»`);
    return;
  }
  throw new Error(`esperaba error «${msg}», pero no falló`);
};
