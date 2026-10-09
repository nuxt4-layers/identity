import type { PostgresPoolLike } from '../../contracts'

/**
 * PRIVATE. Versioned, append-only migrations for Identity's schema
 * (ADR-0002). Never edit a released migration; add a new one.
 *
 * Placeholders: `{{schema}}` is the quoted schema, `{{runtime}}` the quoted
 * runtime role the host connects with at request time.
 *
 * Security model (ADR-0006 §5; Data Store Security Standard §3.5):
 *
 * - The migration role owns every table and function. The runtime role owns
 *   nothing and must not have BYPASSRLS (the migration refuses one that does).
 * - Tenant-isolated tables (`tenant`, `group`, `membership`,
 *   `identity_external_id`) have row-level security keyed on the
 *   transaction-local setting `identity.tenant_ids` (`SET LOCAL`). With no
 *   setting, the runtime role sees nothing.
 * - Tables that span tenants (`identity`, `outbox`, `provisioning_request`)
 *   are not granted to the runtime role at all. It reaches them only through
 *   SECURITY DEFINER functions that return exactly a port's answer, with a
 *   fixed `search_path`.
 */
export const IDENTITY_MIGRATIONS: readonly { id: string, sql: string }[] = [
  {
    id: '0001_foundation',
    sql: `
-- Helpers ---------------------------------------------------------------

create function {{schema}}.uuid_v7() returns uuid language sql volatile as $$
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
$$;

create function {{schema}}.iso(p_at timestamptz) returns text language sql immutable strict as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create function {{schema}}.current_tenant_ids() returns uuid[] language sql stable as $$
  select coalesce(nullif(current_setting('identity.tenant_ids', true), '')::uuid[], '{}'::uuid[])
$$;

-- Tables ----------------------------------------------------------------

create table {{schema}}.tenant (
  tenant_id uuid primary key,
  external_id text unique,
  state text not null check (state in ('active', 'closing', 'closed')),
  jurisdiction text not null,
  data_region text not null,
  created_at timestamptz not null,
  version integer not null check (version >= 1)
);

create table {{schema}}.identity (
  identity_id uuid primary key,
  kind text not null check (kind in ('person', 'service', 'break-glass')),
  state text not null check (state in ('pending', 'active', 'paused', 'suspended', 'closure-pending', 'closed')),
  previous_state text check (previous_state in ('active', 'paused', 'suspended')),
  home_tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  personal_group_id uuid unique,
  owner_group_id uuid,
  created_at timestamptz not null,
  state_changed_at timestamptz not null,
  deadline_at timestamptz,
  version integer not null check (version >= 1)
);
create index identity_pending_deadline_idx on {{schema}}.identity (deadline_at) where state = 'pending';

create table {{schema}}.provisioning_request (
  request_id uuid primary key,
  identity_id uuid not null unique references {{schema}}.identity (identity_id),
  created_at timestamptz not null
);

create table {{schema}}."group" (
  group_id uuid primary key,
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  kind text not null check (kind in ('personal', 'standard')),
  parent_group_id uuid references {{schema}}."group" (group_id),
  name text,
  external_id text,
  state text not null check (state in ('active', 'orphaned', 'archived')),
  settings jsonb,
  created_at timestamptz not null,
  version integer not null check (version >= 1),
  unique (tenant_id, external_id),
  check ((kind = 'personal') = (name is null and settings is null)),
  check (kind = 'standard' or (parent_group_id is null and state = 'active')),
  check (parent_group_id is distinct from group_id)
);
create index group_parent_idx on {{schema}}."group" (parent_group_id);
create index group_tenant_idx on {{schema}}."group" (tenant_id);

create table {{schema}}.membership (
  membership_id uuid primary key,
  identity_id uuid not null references {{schema}}.identity (identity_id),
  group_id uuid not null references {{schema}}."group" (group_id),
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  kind text not null check (kind in ('member', 'guest')),
  state text not null check (state in ('active', 'paused', 'suspended', 'ended')),
  owner boolean not null,
  founding_owner boolean not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  ended_at timestamptz,
  end_reason text check (end_reason in ('left', 'removed', 'expired', 'identity-closed', 'group-archived')),
  reason_code text,
  created_at timestamptz not null,
  version integer not null check (version >= 1),
  check (ends_at is null or ends_at > starts_at),
  check ((state = 'ended') = (ended_at is not null and end_reason is not null)),
  check (kind = 'member' or (ends_at is not null and not owner))
);
create index membership_identity_idx on {{schema}}.membership (identity_id) where state <> 'ended';
create index membership_group_idx on {{schema}}.membership (group_id);
create unique index membership_one_live_per_group on {{schema}}.membership (identity_id, group_id) where state <> 'ended';

create table {{schema}}.identity_external_id (
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  identity_id uuid not null references {{schema}}.identity (identity_id),
  external_id text not null,
  primary key (tenant_id, external_id),
  unique (tenant_id, identity_id)
);

create table {{schema}}.outbox (
  sequence bigint generated always as identity primary key,
  event_id uuid not null unique,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  published_at timestamptz
);
create index outbox_unpublished_idx on {{schema}}.outbox (sequence) where published_at is null;

-- Row-level security on tenant-isolated tables ----------------------------

alter table {{schema}}.tenant enable row level security;
alter table {{schema}}."group" enable row level security;
alter table {{schema}}.membership enable row level security;
alter table {{schema}}.identity_external_id enable row level security;
create policy tenant_isolation on {{schema}}.tenant using (tenant_id = any ({{schema}}.current_tenant_ids()));
create policy tenant_isolation on {{schema}}."group" using (tenant_id = any ({{schema}}.current_tenant_ids()));
create policy tenant_isolation on {{schema}}.membership using (tenant_id = any ({{schema}}.current_tenant_ids()));
create policy tenant_isolation on {{schema}}.identity_external_id using (tenant_id = any ({{schema}}.current_tenant_ids()));

-- Internal functions (not granted) ----------------------------------------

create function {{schema}}.enqueue_event(p_type text, p_actor uuid, p_aggregate_type text, p_aggregate_id uuid, p_version integer, p_tenant uuid, p_correlation uuid, p_at timestamptz, p_data jsonb)
returns void language sql volatile as $$
  insert into {{schema}}.outbox (event_id, type, payload, created_at)
  select e.id, p_type, jsonb_build_object(
    'eventId', e.id, 'type', p_type, 'occurredAt', {{schema}}.iso(p_at), 'correlationId', p_correlation,
    'actorId', p_actor, 'aggregate', jsonb_build_object('type', p_aggregate_type, 'id', p_aggregate_id, 'version', p_version),
    'tenantId', p_tenant, 'data', p_data), p_at
  from (select {{schema}}.uuid_v7() as id) e
$$;

create function {{schema}}.lineage_of(p_group uuid) returns uuid[] language sql stable as $$
  with recursive up (group_id, parent_group_id, depth) as (
    select g.group_id, g.parent_group_id, 0 from {{schema}}."group" g where g.group_id = p_group
    union all
    select g.group_id, g.parent_group_id, up.depth + 1 from {{schema}}."group" g join up on g.group_id = up.parent_group_id where up.depth < 64
  )
  select array_agg(up.group_id order by up.depth desc) from up
$$;

create function {{schema}}.group_json(p_group uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('groupId', g.group_id, 'tenantId', g.tenant_id, 'lineage', to_jsonb({{schema}}.lineage_of(g.group_id)), 'kind', g.kind, 'state', g.state)
  from {{schema}}."group" g where g.group_id = p_group
$$;

-- Port functions (SECURITY DEFINER; granted to the runtime role) ----------

create function {{schema}}.create_tenant(p_jurisdiction text, p_region text, p_external text, p_correlation uuid, p_at timestamptz)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := {{schema}}.uuid_v7();
begin
  insert into {{schema}}.tenant values (v_id, p_external, 'active', p_jurisdiction, p_region, p_at, 1);
  perform {{schema}}.enqueue_event('tenant.created', null, 'tenant', v_id, 1, v_id, p_correlation, p_at,
    jsonb_build_object('tenantId', v_id, 'jurisdiction', p_jurisdiction, 'dataRegion', p_region));
  return v_id;
end $$;

create function {{schema}}.reserve_identity(p_request uuid, p_home uuid, p_deadline timestamptz, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid; v_existing uuid;
begin
  select r.identity_id into v_existing from {{schema}}.provisioning_request r where r.request_id = p_request;
  if v_existing is null then
    if not exists (select 1 from {{schema}}.tenant t where t.tenant_id = p_home and t.state = 'active') then
      raise exception 'identity:tenant-unavailable';
    end if;
    v_id := {{schema}}.uuid_v7();
    insert into {{schema}}.identity values (v_id, 'person', 'pending', null, p_home, null, null, p_at, p_at, p_deadline, 1);
    insert into {{schema}}.provisioning_request values (p_request, v_id, p_at) on conflict (request_id) do nothing;
    select r.identity_id into v_existing from {{schema}}.provisioning_request r where r.request_id = p_request;
    if v_existing <> v_id then
      delete from {{schema}}.identity where identity_id = v_id;
    end if;
  end if;
  return (select jsonb_build_object('identityId', i.identity_id, 'state', i.state, 'expiresAt', {{schema}}.iso(i.deadline_at))
    from {{schema}}.identity i where i.identity_id = v_existing);
end $$;

create function {{schema}}.confirm_identity(p_identity uuid, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v {{schema}}.identity%rowtype; v_group uuid; v_membership uuid;
begin
  select * into v from {{schema}}.identity where identity_id = p_identity for update;
  if not found or v.kind <> 'person' then raise exception 'identity:unknown'; end if;
  if v.state <> 'pending' then
    if v.personal_group_id is not null and v.state <> 'closed' then
      return jsonb_build_object('identityId', v.identity_id, 'state', 'active', 'personalGroupId', v.personal_group_id, 'homeTenantId', v.home_tenant_id);
    end if;
    raise exception 'identity:not-pending';
  end if;
  if v.deadline_at <= p_at then raise exception 'identity:expired'; end if;
  if not exists (select 1 from {{schema}}.tenant t where t.tenant_id = v.home_tenant_id and t.state = 'active') then
    raise exception 'identity:tenant-unavailable';
  end if;
  v_group := {{schema}}.uuid_v7();
  v_membership := {{schema}}.uuid_v7();
  insert into {{schema}}."group" values (v_group, v.home_tenant_id, 'personal', null, null, null, 'active', null, p_at, 1);
  insert into {{schema}}.membership values (v_membership, v.identity_id, v_group, v.home_tenant_id, 'member', 'active', true, true, p_at, null, null, null, null, p_at, 1);
  update {{schema}}.identity set state = 'active', personal_group_id = v_group, deadline_at = null, state_changed_at = p_at, version = version + 1
    where identity_id = v.identity_id;
  perform {{schema}}.enqueue_event('identity.provisioned', v.identity_id, 'identity', v.identity_id, v.version + 1, null, p_correlation, p_at,
    jsonb_build_object('identityId', v.identity_id, 'kind', 'person', 'homeTenantId', v.home_tenant_id, 'personalGroupId', v_group));
  return jsonb_build_object('identityId', v.identity_id, 'state', 'active', 'personalGroupId', v_group, 'homeTenantId', v.home_tenant_id);
end $$;

create function {{schema}}.expire_pending_identities(p_correlation uuid, p_at timestamptz, p_limit integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in select identity_id, version from {{schema}}.identity
    where state = 'pending' and deadline_at <= p_at order by deadline_at limit p_limit for update skip locked
  loop
    update {{schema}}.identity set state = 'closed', deadline_at = null, state_changed_at = p_at, version = version + 1 where identity_id = r.identity_id;
    perform {{schema}}.enqueue_event('identity.provisioning-expired', null, 'identity', r.identity_id, r.version + 1, null, p_correlation, p_at,
      jsonb_build_object('identityId', r.identity_id));
    n := n + 1;
  end loop;
  return n;
end $$;

create function {{schema}}.sign_in_status(p_identity uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('identityId', i.identity_id, 'kind', i.kind, 'state', i.state)
  from {{schema}}.identity i where i.identity_id = p_identity
$$;

create function {{schema}}.resolve_actor(p_identity uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'identityId', i.identity_id, 'kind', i.kind, 'identityState', i.state,
    'personalGroup', case when i.personal_group_id is null then null else {{schema}}.group_json(i.personal_group_id) end,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', m.membership_id, 'group', {{schema}}.group_json(m.group_id), 'kind', m.kind, 'state', m.state,
        'owner', m.owner, 'startsAt', {{schema}}.iso(m.starts_at), 'endsAt', {{schema}}.iso(m.ends_at)) order by m.created_at, m.membership_id)
      from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
      where m.identity_id = i.identity_id and m.state <> 'ended' and g.kind = 'standard'), '[]'::jsonb))
  from {{schema}}.identity i where i.identity_id = p_identity and i.state <> 'pending'
$$;

create function {{schema}}.describe_group(p_group uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.group_json(p_group)
$$;

create function {{schema}}.claim_outbox(p_limit integer)
returns table (sequence bigint, payload jsonb) language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select o.sequence, o.payload from {{schema}}.outbox o
  where o.published_at is null order by o.sequence limit p_limit for update skip locked
$$;

create function {{schema}}.mark_outbox_published(p_sequences bigint[], p_at timestamptz)
returns integer language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  with done as (update {{schema}}.outbox set published_at = p_at where sequence = any (p_sequences) and published_at is null returning 1)
  select count(*)::integer from done
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all tables in schema {{schema}} from public;
revoke all on all functions in schema {{schema}} from public;
grant usage on schema {{schema}} to {{runtime}};
grant select on {{schema}}.tenant, {{schema}}."group", {{schema}}.membership, {{schema}}.identity_external_id to {{runtime}};
grant execute on function {{schema}}.current_tenant_ids() to {{runtime}};
grant execute on function
  {{schema}}.create_tenant(text, text, text, uuid, timestamptz),
  {{schema}}.reserve_identity(uuid, uuid, timestamptz, timestamptz),
  {{schema}}.confirm_identity(uuid, uuid, timestamptz),
  {{schema}}.expire_pending_identities(uuid, timestamptz, integer),
  {{schema}}.sign_in_status(uuid),
  {{schema}}.resolve_actor(uuid),
  {{schema}}.describe_group(uuid),
  {{schema}}.claim_outbox(integer),
  {{schema}}.mark_outbox_published(bigint[], timestamptz)
to {{runtime}};
`,
  },
]

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/

export function quoteIdentifier(name: string, what: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) throw new TypeError(`Invalid identity ${what} name '${name}'.`)
  return `"${name}"`
}

interface PoolClientLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}

/**
 * Applies pending migrations with the migration (owner) role, inside one
 * transaction serialised by an advisory lock. Refuses a runtime role that
 * could bypass row-level security or that is the migration role itself.
 * Returns the ids applied.
 */
export async function runIdentityMigrations(pool: PostgresPoolLike, schema: string, runtimeRole: string): Promise<string[]> {
  const quotedSchema = quoteIdentifier(schema, 'schema')
  const quotedRuntime = quoteIdentifier(runtimeRole, 'runtime role')
  const client = await pool.connect() as PoolClientLike
  const applied: string[] = []
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`identity-migrations:${schema}`])
    const role = await client.query('select rolsuper, rolbypassrls, rolname = current_user as is_self from pg_roles where rolname = $1', [runtimeRole])
    if (role.rows.length === 0) throw new Error(`Identity runtime role '${runtimeRole}' does not exist.`)
    const { rolsuper, rolbypassrls, is_self: isSelf } = role.rows[0] as { rolsuper: boolean, rolbypassrls: boolean, is_self: boolean }
    if (rolsuper || rolbypassrls || isSelf) {
      throw new Error(`Identity runtime role '${runtimeRole}' must not be a superuser, bypass row-level security, or be the migration role.`)
    }
    const existing = await client.query('select 1 from pg_namespace where nspname = $1', [schema])
    if (existing.rows.length === 0) await client.query(`create schema ${quotedSchema}`)
    await client.query(`create table if not exists ${quotedSchema}."schema_migration" ("id" text primary key, "applied_at" timestamptz not null default now())`)
    await client.query(`revoke all on ${quotedSchema}."schema_migration" from public`)
    const { rows } = await client.query(`select "id" from ${quotedSchema}."schema_migration"`)
    const done = new Set(rows.map(row => row.id))
    for (const migration of IDENTITY_MIGRATIONS) {
      if (done.has(migration.id)) continue
      await client.query(migration.sql.replaceAll('{{schema}}', quotedSchema).replaceAll('{{runtime}}', quotedRuntime))
      await client.query(`insert into ${quotedSchema}."schema_migration" ("id") values ($1)`, [migration.id])
      applied.push(migration.id)
    }
    await client.query('commit')
    return applied
  }
  catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
  finally {
    client.release()
  }
}
