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
  {
    id: '0002_groups_memberships_disclosure',
    sql: `
-- Request context ---------------------------------------------------------
-- Database.transaction sets these transaction-local values; triggers read
-- them so that every event carries the request's correlation identifier
-- and actor without the runtime role ever touching the outbox.

create function {{schema}}.context_uuid(p_name text) returns uuid language sql stable as $$
  select nullif(current_setting(p_name, true), '')::uuid
$$;

create function {{schema}}.context_at() returns timestamptz language sql stable as $$
  select coalesce(nullif(current_setting('identity.at', true), '')::timestamptz, now())
$$;

-- Confusable sibling names (safe names, improvement register item 6) -----

alter table {{schema}}."group" add column name_skeleton text;
alter table {{schema}}."group" add constraint group_skeleton_with_name check ((name is null) = (name_skeleton is null));
create unique index group_sibling_skeleton_idx on {{schema}}."group"
  (tenant_id, coalesce(parent_group_id, '00000000-0000-0000-0000-000000000000'::uuid), name_skeleton) where name_skeleton is not null;

-- Versions and the hierarchy, enforced in the database as well -------------

create function {{schema}}.bump_version() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

create trigger group_version before update on {{schema}}."group" for each row execute function {{schema}}.bump_version();
create trigger membership_version before update on {{schema}}.membership for each row execute function {{schema}}.bump_version();

create function {{schema}}.check_hierarchy() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_parent {{schema}}."group"%rowtype; v_lineage uuid[];
begin
  if new.parent_group_id is null then return new; end if;
  select * into v_parent from {{schema}}."group" where group_id = new.parent_group_id;
  if v_parent.tenant_id is distinct from new.tenant_id then raise exception 'identity:hierarchy-tenant'; end if;
  if v_parent.kind <> 'standard' then raise exception 'identity:hierarchy-parent'; end if;
  v_lineage := {{schema}}.lineage_of(new.parent_group_id);
  if new.group_id = any (v_lineage) then raise exception 'identity:hierarchy-cycle'; end if;
  if cardinality(v_lineage) + 1 > 32 then raise exception 'identity:hierarchy-depth'; end if;
  return new;
end $$;

create trigger group_hierarchy before insert or update of parent_group_id, tenant_id on {{schema}}."group"
  for each row execute function {{schema}}.check_hierarchy();

-- Limits on the runtime role's direct writes --------------------------------
-- Defence in depth: only the table owner (migrations and SECURITY DEFINER
-- functions) may create root or personal groups, or memberships that confer
-- ownership, except the founding owner of a group created in this request.

create function {{schema}}.is_owner_role() returns boolean language sql stable as $$
  select current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = '{{schema}}."group"'::regclass)
$$;

create function {{schema}}.guard_group_insert() returns trigger language plpgsql as $$
begin
  if {{schema}}.is_owner_role() then return new; end if;
  if new.kind <> 'standard' or new.parent_group_id is null or new.state <> 'active' or new.external_id is not null then
    raise exception 'identity:requires-approval';
  end if;
  return new;
end $$;

create trigger group_guard before insert on {{schema}}."group" for each row execute function {{schema}}.guard_group_insert();

create function {{schema}}.guard_membership_insert() returns trigger language plpgsql as $$
begin
  if {{schema}}.is_owner_role() then return new; end if;
  if new.owner or new.founding_owner then
    if not (new.owner and new.founding_owner and new.kind = 'member' and new.state = 'active'
      and not exists (select 1 from {{schema}}.membership m where m.group_id = new.group_id)
      and exists (select 1 from {{schema}}."group" g where g.group_id = new.group_id and g.xmin = pg_current_xact_id()::xid)) then
      raise exception 'identity:requires-approval';
    end if;
  end if;
  return new;
end $$;

create trigger membership_guard before insert on {{schema}}.membership for each row execute function {{schema}}.guard_membership_insert();

-- Events from row changes ---------------------------------------------------

create function {{schema}}.group_events() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_correlation uuid := {{schema}}.context_uuid('identity.correlation_id');
  v_actor uuid := {{schema}}.context_uuid('identity.actor_id');
  v_at timestamptz := {{schema}}.context_at();
  v_changed jsonb;
begin
  if new.kind = 'personal' then return new; end if;
  if v_correlation is null then raise exception 'identity:correlation-required'; end if;
  if tg_op = 'INSERT' then
    if v_actor is null then raise exception 'identity:actor-required'; end if;
    perform {{schema}}.enqueue_event('group.created', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', new.group_id, 'lineage', to_jsonb({{schema}}.lineage_of(new.group_id)), 'foundingOwnerId', v_actor));
    return new;
  end if;
  if new.name is distinct from old.name then
    perform {{schema}}.enqueue_event('group.renamed', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', new.group_id));
  end if;
  if new.settings is distinct from old.settings then
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
    from jsonb_object_keys(new.settings) k where new.settings -> k is distinct from old.settings -> k;
    if jsonb_array_length(v_changed) > 0 then
      perform {{schema}}.enqueue_event('group.settings-changed', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
        jsonb_build_object('groupId', new.group_id, 'changed', v_changed));
    end if;
  end if;
  return new;
end $$;

create trigger group_events after insert or update on {{schema}}."group" for each row execute function {{schema}}.group_events();

create function {{schema}}.membership_events() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_correlation uuid := {{schema}}.context_uuid('identity.correlation_id');
  v_actor uuid := {{schema}}.context_uuid('identity.actor_id');
  v_at timestamptz := {{schema}}.context_at();
  v_base jsonb := jsonb_build_object('membershipId', new.membership_id, 'identityId', new.identity_id, 'groupId', new.group_id);
  v_type text;
  v_data jsonb;
begin
  -- A personal group's membership follows its identity; provisioning announces it.
  if exists (select 1 from {{schema}}."group" g where g.group_id = new.group_id and g.kind = 'personal') then return new; end if;
  if v_correlation is null then raise exception 'identity:correlation-required'; end if;
  if tg_op = 'INSERT' then
    v_type := 'membership.added';
    v_data := v_base || jsonb_build_object('kind', new.kind, 'owner', new.owner, 'startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  elsif new.state is distinct from old.state then
    if new.state = 'ended' then
      v_type := 'membership.ended';
      v_data := v_base || jsonb_build_object('endReason', new.end_reason, 'reasonCode', new.reason_code);
    elsif new.state = 'paused' then
      v_type := 'membership.paused'; v_data := v_base;
    elsif new.state = 'suspended' then
      v_type := 'membership.suspended';
      v_data := v_base || jsonb_build_object('reasonCode', new.reason_code, 'changeId', null, 'breakGlassReviewId', null);
    elsif old.state = 'paused' then
      v_type := 'membership.resumed'; v_data := v_base;
    else
      v_type := 'membership.reinstated'; v_data := v_base || jsonb_build_object('changeId', null);
    end if;
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_type := 'membership.dates-changed';
    v_data := v_base || jsonb_build_object('startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  else
    return new;
  end if;
  perform {{schema}}.enqueue_event(v_type, v_actor, 'membership', new.membership_id, new.version, new.tenant_id, v_correlation, v_at, v_data);
  return new;
end $$;

create trigger membership_events after insert or update on {{schema}}.membership for each row execute function {{schema}}.membership_events();

-- Port and lookup functions (SECURITY DEFINER) -------------------------------

-- Where a membership lives, and what governance needs to know about it.
create function {{schema}}.locate_membership(p_membership uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'membershipId', m.membership_id, 'identityId', m.identity_id, 'groupId', m.group_id, 'tenantId', m.tenant_id,
    'groupKind', g.kind, 'groupState', g.state, 'state', m.state, 'kind', m.kind, 'owner', m.owner,
    'otherActiveOwners', (select count(*) from {{schema}}.membership o join {{schema}}.identity oi on oi.identity_id = o.identity_id
      where o.group_id = m.group_id and o.owner and o.state = 'active' and o.membership_id <> m.membership_id and oi.state = 'active'))
  from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
  where m.membership_id = p_membership
$$;

-- Lapsed memberships: recorded ended (expired) once past their end date.
create function {{schema}}.sweep_lapsed_memberships(p_correlation uuid, p_at timestamptz, p_limit integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare n integer;
begin
  perform set_config('identity.correlation_id', p_correlation::text, true);
  perform set_config('identity.actor_id', '', true);
  perform set_config('identity.at', p_at::text, true);
  with lapsed as (
    select membership_id from {{schema}}.membership
    where state <> 'ended' and ends_at is not null and ends_at <= p_at
    order by ends_at limit p_limit for update skip locked
  )
  update {{schema}}.membership m set state = 'ended', ended_at = p_at, end_reason = 'expired'
  from lapsed where m.membership_id = lapsed.membership_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Facts for the disclosure-context port: the viewer's memberships, and each
-- subject's state and memberships in the viewer's groups and tenants only.
create function {{schema}}.disclosure_facts(p_viewer uuid, p_subjects uuid[], p_group uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with viewer as (
    select m.group_id, m.tenant_id, m.state, m.starts_at, m.ends_at
    from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
    where m.identity_id = p_viewer and g.kind = 'standard' and m.state <> 'ended'
  )
  select jsonb_build_object(
    'viewerState', (select i.state from {{schema}}.identity i where i.identity_id = p_viewer),
    'viewer', coalesce((select jsonb_agg(jsonb_build_object('groupId', v.group_id, 'tenantId', v.tenant_id, 'state', v.state,
      'startsAt', {{schema}}.iso(v.starts_at), 'endsAt', {{schema}}.iso(v.ends_at))) from viewer v), '[]'::jsonb),
    'departurePolicy', (select g.settings -> 'departure' from {{schema}}."group" g where g.group_id = p_group and g.kind = 'standard'),
    'subjects', coalesce((select jsonb_agg(jsonb_build_object(
      'subjectId', s.id,
      'state', (select i.state from {{schema}}.identity i where i.identity_id = s.id),
      'memberships', coalesce((select jsonb_agg(jsonb_build_object('groupId', m.group_id, 'tenantId', m.tenant_id, 'kind', m.kind,
          'state', m.state, 'startsAt', {{schema}}.iso(m.starts_at), 'endsAt', {{schema}}.iso(m.ends_at), 'endedAt', {{schema}}.iso(m.ended_at)))
        from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
        where m.identity_id = s.id and g.kind = 'standard'
          and (m.group_id = p_group or m.tenant_id in (select v.tenant_id from viewer v))), '[]'::jsonb)))
      from unnest(p_subjects) as s(id)), '[]'::jsonb))
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
grant insert on {{schema}}."group", {{schema}}.membership to {{runtime}};
-- Only the columns phase 2b changes; owners, settings, states of groups and
-- membership dates change through the approvals of phase 3.
grant update (name, name_skeleton) on {{schema}}."group" to {{runtime}};
grant update (state, ended_at, end_reason, reason_code) on {{schema}}.membership to {{runtime}};
grant execute on function
  {{schema}}.current_tenant_ids(),
  {{schema}}.is_owner_role(),
  {{schema}}.uuid_v7(),
  {{schema}}.locate_membership(uuid),
  {{schema}}.sweep_lapsed_memberships(uuid, timestamptz, integer),
  {{schema}}.disclosure_facts(uuid, uuid[], uuid)
to {{runtime}};
`,
  },
  {
    id: '0003_governance_approvals',
    sql: `
-- Pending governance changes ------------------------------------------------
-- Recorded, decided, cancelled and applied only through the SECURITY
-- DEFINER functions below. The runtime role may read them, under row-level
-- security on the tenant of the group that governs the change, and nothing
-- else: it can neither forge an approval nor apply a change itself.

create table {{schema}}.pending_change (
  change_id uuid primary key,
  type text not null,
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  group_id uuid not null references {{schema}}."group" (group_id),
  requester_id uuid not null references {{schema}}.identity (identity_id),
  beneficiary_id uuid references {{schema}}.identity (identity_id),
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  reason_code text not null,
  reference text,
  target jsonb not null,
  created_id uuid,
  internal jsonb not null,
  required_approvals integer not null check (required_approvals between 0 and 2),
  route text not null check (route in ('approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'none')),
  approvals jsonb not null,
  change_digest text not null,
  delay_ends_at timestamptz,
  expires_at timestamptz,
  state text not null check (state in ('awaiting-approval', 'delayed', 'applied', 'rejected', 'expired', 'cancelled')),
  failure text,
  correlation_id uuid not null,
  created_at timestamptz not null,
  decided_at timestamptz,
  version integer not null check (version >= 1),
  check ((route = 'none') = (required_approvals = 0)),
  check ((route = 'published-delay') = (delay_ends_at is not null)),
  check ((route in ('approvers', 'parent-owner', 'tenant-owner')) = (expires_at is not null)),
  check ((state in ('awaiting-approval', 'delayed')) = (decided_at is null))
);
create index pending_change_awaiting_idx on {{schema}}.pending_change (expires_at) where state = 'awaiting-approval';
create index pending_change_delayed_idx on {{schema}}.pending_change (delay_ends_at) where state = 'delayed';
create index pending_change_group_idx on {{schema}}.pending_change (group_id, created_at);

alter table {{schema}}.pending_change enable row level security;
create policy tenant_isolation on {{schema}}.pending_change using (tenant_id = any ({{schema}}.current_tenant_ids()));
create trigger pending_change_version before update on {{schema}}.pending_change for each row execute function {{schema}}.bump_version();

-- Rules the database holds as well as the layer (internal) --------------------

create function {{schema}}.risk_rank(p_risk text) returns integer language sql immutable as $$
  select array_position(array['low', 'medium', 'high', 'critical'], p_risk)
$$;

-- The risk Identity declares for each change; a host's catalogue may raise it, never lower it.
create function {{schema}}.declared_risk(p_type text) returns text language sql immutable as $$
  select case p_type
    when 'group.create-root' then 'high' when 'group.reparent' then 'critical' when 'group.archive' then 'high'
    when 'group.change-settings' then 'high' when 'group.change-approvals' then 'critical'
    when 'group.add-owner' then 'critical' when 'group.remove-owner' then 'critical' when 'group.suspend-owner' then 'critical'
    when 'membership.reinstate' then 'medium' when 'membership.schedule' then 'medium'
    when 'identity.suspend' then 'high' when 'identity.reinstate' then 'high' when 'service-identity.create' then 'high'
  end
$$;

create function {{schema}}.confers(p_type text) returns boolean language sql immutable as $$
  select p_type in ('group.add-owner', 'group.appoint-owner', 'membership.reinstate', 'membership.schedule', 'identity.reinstate')
$$;

-- Owners in effect now: active membership within its dates, of an active person.
create function {{schema}}.active_owner_count(p_group uuid, p_excluding uuid[]) returns integer language sql stable as $$
  select count(*)::integer from {{schema}}.membership m join {{schema}}.identity i on i.identity_id = m.identity_id
  where m.group_id = p_group and m.owner and m.state = 'active' and i.state = 'active' and i.kind = 'person'
    and m.starts_at <= {{schema}}.context_at() and (m.ends_at is null or m.ends_at > {{schema}}.context_at())
    and not (m.identity_id = any (coalesce(p_excluding, '{}'::uuid[])))
$$;

create function {{schema}}.owns(p_identity uuid, p_group uuid) returns boolean language sql stable as $$
  select {{schema}}.active_owner_count(p_group, '{}'::uuid[]) > {{schema}}.active_owner_count(p_group, array[p_identity])
$$;

-- The digest an approval binds to: everything the change will do.
create function {{schema}}.digest_of(c {{schema}}.pending_change) returns text language sql stable as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'type', c.type, 'tenantId', c.tenant_id, 'groupId', c.group_id, 'requesterId', c.requester_id,
    'beneficiaryId', c.beneficiary_id, 'risk', c.risk, 'reasonCode', c.reason_code, 'reference', c.reference,
    'target', c.target, 'createdId', c.created_id, 'internal', c.internal, 'requiredApprovals', c.required_approvals,
    'route', c.route)::text, 'UTF8')), 'hex')
$$;

create function {{schema}}.change_json(c {{schema}}.pending_change) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'changeId', c.change_id, 'type', c.type, 'tenantId', c.tenant_id, 'groupId', c.group_id,
    'requesterId', c.requester_id, 'beneficiaryId', c.beneficiary_id, 'risk', c.risk,
    'justification', jsonb_build_object('reasonCode', c.reason_code, 'reference', c.reference),
    'target', c.target, 'createdId', c.created_id, 'requiredApprovals', c.required_approvals, 'route', c.route,
    'approvals', c.approvals, 'changeDigest', c.change_digest, 'delayEndsAt', {{schema}}.iso(c.delay_ends_at),
    'expiresAt', {{schema}}.iso(c.expires_at), 'state', c.state, 'correlationId', c.correlation_id,
    'createdAt', {{schema}}.iso(c.created_at), 'decidedAt', {{schema}}.iso(c.decided_at), 'version', c.version)
$$;

-- Events: the founding owner, and the change behind a membership event --------
-- A root group's founding owner may differ from the requester. Only the
-- owner role can say so, through a claim the runtime role cannot write;
-- otherwise the founding owner is the actor, and the runtime role may make
-- only itself the founding owner of a group it creates.

create table {{schema}}.founding_claim (
  group_id uuid primary key,
  identity_id uuid not null
);

create or replace function {{schema}}.guard_membership_insert() returns trigger language plpgsql as $$
begin
  if {{schema}}.is_owner_role() then return new; end if;
  if new.owner or new.founding_owner then
    if not (new.owner and new.founding_owner and new.kind = 'member' and new.state = 'active'
      and new.identity_id = nullif(current_setting('identity.actor_id', true), '')::uuid
      and not exists (select 1 from {{schema}}.membership m where m.group_id = new.group_id)
      and exists (select 1 from {{schema}}."group" g where g.group_id = new.group_id and g.xmin = pg_current_xact_id()::xid)) then
      raise exception 'identity:requires-approval';
    end if;
  end if;
  return new;
end $$;

create or replace function {{schema}}.group_events() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_correlation uuid := {{schema}}.context_uuid('identity.correlation_id');
  v_actor uuid := {{schema}}.context_uuid('identity.actor_id');
  v_founder uuid;
  v_at timestamptz := {{schema}}.context_at();
  v_changed jsonb;
begin
  if new.kind = 'personal' then return new; end if;
  if v_correlation is null then raise exception 'identity:correlation-required'; end if;
  if tg_op = 'INSERT' then
    select f.identity_id into v_founder from {{schema}}.founding_claim f where f.group_id = new.group_id;
    v_founder := coalesce(v_founder, v_actor);
    if v_founder is null then raise exception 'identity:actor-required'; end if;
    perform {{schema}}.enqueue_event('group.created', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', new.group_id, 'lineage', to_jsonb({{schema}}.lineage_of(new.group_id)), 'foundingOwnerId', v_founder));
    return new;
  end if;
  if new.name is distinct from old.name then
    perform {{schema}}.enqueue_event('group.renamed', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', new.group_id));
  end if;
  if new.settings is distinct from old.settings then
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
    from jsonb_object_keys(new.settings) k where new.settings -> k is distinct from old.settings -> k;
    if jsonb_array_length(v_changed) > 0 then
      perform {{schema}}.enqueue_event('group.settings-changed', v_actor, 'group', new.group_id, new.version, new.tenant_id, v_correlation, v_at,
        jsonb_build_object('groupId', new.group_id, 'changed', v_changed));
    end if;
  end if;
  return new;
end $$;

create or replace function {{schema}}.membership_events() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_correlation uuid := {{schema}}.context_uuid('identity.correlation_id');
  v_actor uuid := {{schema}}.context_uuid('identity.actor_id');
  v_change uuid := {{schema}}.context_uuid('identity.change_id');
  v_at timestamptz := {{schema}}.context_at();
  v_base jsonb := jsonb_build_object('membershipId', new.membership_id, 'identityId', new.identity_id, 'groupId', new.group_id);
  v_type text;
  v_data jsonb;
begin
  -- A personal group's membership follows its identity; provisioning announces it.
  if exists (select 1 from {{schema}}."group" g where g.group_id = new.group_id and g.kind = 'personal') then return new; end if;
  if v_correlation is null then raise exception 'identity:correlation-required'; end if;
  if tg_op = 'INSERT' then
    v_type := 'membership.added';
    v_data := v_base || jsonb_build_object('kind', new.kind, 'owner', new.owner, 'startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  elsif new.state is distinct from old.state then
    if new.state = 'ended' then
      v_type := 'membership.ended';
      v_data := v_base || jsonb_build_object('endReason', new.end_reason, 'reasonCode', new.reason_code);
    elsif new.state = 'paused' then
      v_type := 'membership.paused'; v_data := v_base;
    elsif new.state = 'suspended' then
      v_type := 'membership.suspended';
      v_data := v_base || jsonb_build_object('reasonCode', new.reason_code, 'changeId', v_change, 'breakGlassReviewId', null);
    elsif old.state = 'paused' then
      v_type := 'membership.resumed'; v_data := v_base;
    else
      v_type := 'membership.reinstated'; v_data := v_base || jsonb_build_object('changeId', v_change);
    end if;
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_type := 'membership.dates-changed';
    v_data := v_base || jsonb_build_object('startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  else
    return new;
  end if;
  perform {{schema}}.enqueue_event(v_type, v_actor, 'membership', new.membership_id, new.version, new.tenant_id, v_correlation, v_at, v_data);
  return new;
end $$;

-- Limits on the runtime role's direct membership updates -------------------
-- It may pause, resume, end and suspend (phase 2b), but never revive an
-- ended membership, reinstate a suspended one, or suspend or remove an
-- owner: those are approved changes.

create function {{schema}}.guard_membership_update() returns trigger language plpgsql as $$
begin
  if {{schema}}.is_owner_role() then return new; end if;
  if old.state = 'ended'
    or (old.state = 'suspended' and new.state not in ('suspended', 'ended'))
    or (old.owner and (new.state = 'suspended' or (new.state = 'ended' and new.end_reason <> 'left'))) then
    raise exception 'identity:requires-approval';
  end if;
  return new;
end $$;

create trigger membership_update_guard before update on {{schema}}.membership for each row execute function {{schema}}.guard_membership_update();

-- Applying a change (internal) -------------------------------------------------
-- Runs as the owner. Every rule is checked again here, at the moment the
-- change takes effect, whatever was true when it was requested.

create function {{schema}}.apply_change(c {{schema}}.pending_change, p_at timestamptz) returns void language plpgsql as $$
declare
  v_group {{schema}}."group"%rowtype;
  v_parent {{schema}}."group"%rowtype;
  v_m {{schema}}.membership%rowtype;
  v_i {{schema}}.identity%rowtype;
  v_target_id uuid;
  v_previous uuid[];
  v_height integer;
  v_version integer;
  v_term integer;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if {{schema}}.digest_of(c) <> c.change_digest then raise exception 'identity:change-differs'; end if;
  perform set_config('identity.correlation_id', c.correlation_id::text, true);
  perform set_config('identity.actor_id', c.requester_id::text, true);
  perform set_config('identity.at', p_at::text, true);
  perform set_config('identity.change_id', c.change_id::text, true);

  if c.type = 'group.create-root' then
    if not exists (select 1 from {{schema}}.tenant t where t.tenant_id = (c.target ->> 'tenantId')::uuid and t.state = 'active') then
      raise exception 'identity:tenant-unavailable';
    end if;
    if not exists (select 1 from {{schema}}.identity i where i.identity_id = (c.target ->> 'firstOwnerId')::uuid and i.kind = 'person' and i.state = 'active') then
      raise exception 'identity:owner-unavailable';
    end if;
    insert into {{schema}}.founding_claim values (c.created_id, (c.target ->> 'firstOwnerId')::uuid);
    insert into {{schema}}."group" (group_id, tenant_id, kind, parent_group_id, name, name_skeleton, external_id, state, settings, created_at, version)
      values (c.created_id, (c.target ->> 'tenantId')::uuid, 'standard', null, c.target ->> 'name', c.internal ->> 'nameSkeleton', null, 'active', c.internal -> 'settings', p_at, 1);
    insert into {{schema}}.membership (membership_id, identity_id, group_id, tenant_id, kind, state, owner, founding_owner, starts_at, ends_at, ended_at, end_reason, reason_code, created_at, version)
      values ({{schema}}.uuid_v7(), (c.target ->> 'firstOwnerId')::uuid, c.created_id, (c.target ->> 'tenantId')::uuid, 'member', 'active', true, true, p_at, null, null, null, null, p_at, 1);
    delete from {{schema}}.founding_claim where group_id = c.created_id;

  elsif c.type in ('group.reparent', 'group.archive', 'group.change-settings', 'group.change-approvals', 'service-identity.create') then
    select * into v_group from {{schema}}."group" where group_id = (c.target ->> 'groupId')::uuid and kind = 'standard' for update;
    if not found then raise exception 'identity:unknown'; end if;
    if v_group.state <> 'active' then raise exception 'identity:group-not-active'; end if;

    if c.type = 'group.reparent' then
      select * into v_parent from {{schema}}."group" where group_id = (c.target ->> 'parentGroupId')::uuid;
      if not found or v_parent.state <> 'active' then raise exception 'identity:group-not-active'; end if;
      with recursive down (group_id, depth) as (
        select v_group.group_id, 0
        union all
        select g.group_id, down.depth + 1 from {{schema}}."group" g join down on g.parent_group_id = down.group_id where down.depth < 64
      )
      select max(depth) into v_height from down;
      if cardinality({{schema}}.lineage_of(v_parent.group_id)) + 1 + v_height > (c.internal ->> 'maxDepth')::integer then
        raise exception 'identity:hierarchy-depth';
      end if;
      v_previous := {{schema}}.lineage_of(v_group.group_id);
      update {{schema}}."group" set parent_group_id = v_parent.group_id where group_id = v_group.group_id returning version into v_version;
      perform {{schema}}.enqueue_event('group.reparented', c.requester_id, 'group', v_group.group_id, v_version, v_group.tenant_id, c.correlation_id, p_at,
        jsonb_build_object('groupId', v_group.group_id, 'previousLineage', to_jsonb(v_previous), 'lineage', to_jsonb({{schema}}.lineage_of(v_group.group_id)), 'changeId', c.change_id));

    elsif c.type = 'group.archive' then
      if exists (select 1 from {{schema}}."group" g where g.parent_group_id = v_group.group_id and g.state <> 'archived') then
        raise exception 'identity:active-children';
      end if;
      if exists (select 1 from {{schema}}.identity i where i.owner_group_id = v_group.group_id and i.state not in ('closed', 'suspended')) then
        raise exception 'identity:active-service-identities';
      end if;
      if v_group.settings ->> 'onArchive' = 'end-memberships' then
        update {{schema}}.membership set state = 'ended', ended_at = p_at, end_reason = 'group-archived'
          where group_id = v_group.group_id and state <> 'ended';
      end if;
      update {{schema}}."group" set state = 'archived' where group_id = v_group.group_id returning version into v_version;
      perform {{schema}}.enqueue_event('group.archived', c.requester_id, 'group', v_group.group_id, v_version, v_group.tenant_id, c.correlation_id, p_at,
        jsonb_build_object('groupId', v_group.group_id, 'changeId', c.change_id));

    elsif c.type = 'group.change-settings' then
      if (v_group.settings - 'approvals') <> (c.internal -> 'baseSettings') then raise exception 'identity:changed-since-request'; end if;
      update {{schema}}."group" set settings = (c.target -> 'settings') || jsonb_build_object('approvals', v_group.settings -> 'approvals')
        where group_id = v_group.group_id;

    elsif c.type = 'group.change-approvals' then
      if (v_group.settings -> 'approvals') <> (c.internal -> 'baseApprovals') then raise exception 'identity:changed-since-request'; end if;
      if (c.target -> 'approvals' -> 'required' ->> 'high')::integer < 1 or (c.target -> 'approvals' -> 'required' ->> 'critical')::integer < 1 then
        raise exception 'identity:approval-floor';
      end if;
      update {{schema}}."group" set settings = jsonb_set(v_group.settings, '{approvals}', c.target -> 'approvals') where group_id = v_group.group_id;

    else -- service-identity.create
      if not exists (select 1 from {{schema}}.tenant t where t.tenant_id = v_group.tenant_id and t.state = 'active') then
        raise exception 'identity:tenant-unavailable';
      end if;
      insert into {{schema}}.identity (identity_id, kind, state, previous_state, home_tenant_id, personal_group_id, owner_group_id, created_at, state_changed_at, deadline_at, version)
        values (c.created_id, 'service', 'active', null, v_group.tenant_id, null, v_group.group_id, p_at, p_at, null, 1);
      perform {{schema}}.enqueue_event('identity.provisioned', c.requester_id, 'identity', c.created_id, 1, null, c.correlation_id, p_at,
        jsonb_build_object('identityId', c.created_id, 'kind', 'service', 'homeTenantId', v_group.tenant_id, 'personalGroupId', null));
    end if;

  elsif c.type in ('group.add-owner', 'group.remove-owner', 'group.suspend-owner', 'membership.reinstate', 'membership.schedule') then
    select * into v_m from {{schema}}.membership where membership_id = (c.target ->> 'membershipId')::uuid for update;
    if not found then raise exception 'identity:unknown'; end if;
    select * into v_group from {{schema}}."group" where group_id = v_m.group_id for update;
    if v_group.kind <> 'standard' then raise exception 'identity:unknown'; end if;
    if v_group.state <> 'active' then raise exception 'identity:group-not-active'; end if;
    if v_m.state = 'ended' then raise exception 'identity:membership-ended'; end if;

    if c.type = 'group.add-owner' then
      if v_m.owner then raise exception 'identity:already-owner'; end if;
      if v_m.kind <> 'member' or v_m.state <> 'active' then raise exception 'identity:not-eligible'; end if;
      if not exists (select 1 from {{schema}}.identity i where i.identity_id = v_m.identity_id and i.kind = 'person' and i.state = 'active') then
        raise exception 'identity:not-eligible';
      end if;
      update {{schema}}.membership set owner = true where membership_id = v_m.membership_id;
      update {{schema}}."group" set version = version where group_id = v_group.group_id returning version into v_version;
      perform {{schema}}.enqueue_event('group.owners-changed', c.requester_id, 'group', v_group.group_id, v_version, v_group.tenant_id, c.correlation_id, p_at,
        jsonb_build_object('groupId', v_group.group_id, 'added', jsonb_build_array(v_m.identity_id), 'removed', '[]'::jsonb, 'changeId', c.change_id, 'breakGlassReviewId', null));

    elsif c.type in ('group.remove-owner', 'group.suspend-owner') then
      if not v_m.owner then raise exception 'identity:not-owner'; end if;
      if {{schema}}.active_owner_count(v_group.group_id, array[v_m.identity_id]) < 1 then raise exception 'identity:last-owner'; end if;
      if c.type = 'group.remove-owner' then
        update {{schema}}.membership set owner = false where membership_id = v_m.membership_id;
        update {{schema}}."group" set version = version where group_id = v_group.group_id returning version into v_version;
        perform {{schema}}.enqueue_event('group.owners-changed', c.requester_id, 'group', v_group.group_id, v_version, v_group.tenant_id, c.correlation_id, p_at,
          jsonb_build_object('groupId', v_group.group_id, 'added', '[]'::jsonb, 'removed', jsonb_build_array(v_m.identity_id), 'changeId', c.change_id, 'breakGlassReviewId', null));
      else
        if v_m.state = 'suspended' then raise exception 'identity:already-suspended'; end if;
        update {{schema}}.membership set state = 'suspended', reason_code = c.reason_code where membership_id = v_m.membership_id;
      end if;

    elsif c.type = 'membership.reinstate' then
      if v_m.state <> 'suspended' then raise exception 'identity:not-suspended'; end if;
      update {{schema}}.membership set state = 'active', reason_code = null where membership_id = v_m.membership_id;

    else -- membership.schedule
      v_starts := (c.target ->> 'startsAt')::timestamptz;
      v_ends := (c.target ->> 'endsAt')::timestamptz;
      if v_ends is not null and (v_ends <= v_starts or v_ends <= p_at) then raise exception 'identity:invalid-dates'; end if;
      if v_m.kind = 'guest' then
        v_term := least((v_group.settings -> 'guests' ->> 'termDays')::integer, (c.internal ->> 'guestTermDays')::integer);
        if v_ends is null or v_ends > greatest(p_at, v_starts) + make_interval(days => v_term) then raise exception 'identity:guest-term'; end if;
      end if;
      update {{schema}}.membership set starts_at = v_starts, ends_at = v_ends where membership_id = v_m.membership_id;
    end if;

  elsif c.type in ('identity.suspend', 'identity.reinstate') then
    select * into v_i from {{schema}}.identity where identity_id = (c.target ->> 'identityId')::uuid for update;
    if not found or v_i.kind not in ('person', 'service') then raise exception 'identity:unknown'; end if;
    if c.type = 'identity.suspend' then
      if v_i.state not in ('active', 'paused') then raise exception 'identity:not-suspendable'; end if;
      update {{schema}}.identity set state = 'suspended', previous_state = v_i.state, state_changed_at = p_at, version = version + 1
        where identity_id = v_i.identity_id;
      perform {{schema}}.enqueue_event('identity.suspended', c.requester_id, 'identity', v_i.identity_id, v_i.version + 1, null, c.correlation_id, p_at,
        jsonb_build_object('identityId', v_i.identity_id, 'reasonCode', c.reason_code, 'changeId', c.change_id, 'breakGlassReviewId', null));
    else
      if v_i.state <> 'suspended' then raise exception 'identity:not-suspended'; end if;
      update {{schema}}.identity set state = coalesce(v_i.previous_state, 'active'), previous_state = null, state_changed_at = p_at, version = version + 1
        where identity_id = v_i.identity_id;
      perform {{schema}}.enqueue_event('identity.reinstated', c.requester_id, 'identity', v_i.identity_id, v_i.version + 1, null, c.correlation_id, p_at,
        jsonb_build_object('identityId', v_i.identity_id, 'changeId', c.change_id));
    end if;

  else
    raise exception 'identity:unknown-change';
  end if;

  perform set_config('identity.change_id', '', true);
end $$;

-- Applies an approved or due change. A rule that no longer holds rejects it,
-- with the reason kept for operators; nothing else in the transaction is lost.
create function {{schema}}.settle_change(p_change uuid, p_at timestamptz, p_actor uuid) returns text language plpgsql as $$
declare c {{schema}}.pending_change%rowtype; v_outcome text; v_version integer;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  begin
    perform {{schema}}.apply_change(c, p_at);
    update {{schema}}.pending_change set state = 'applied', decided_at = p_at where change_id = p_change returning version into v_version;
    v_outcome := 'applied';
  exception when others then
    update {{schema}}.pending_change set state = 'rejected', decided_at = p_at, failure = left(sqlerrm, 200) where change_id = p_change returning version into v_version;
    v_outcome := 'rejected';
  end;
  perform {{schema}}.enqueue_event('approval.decided', p_actor, 'approval', p_change, v_version, c.tenant_id, c.correlation_id, p_at,
    jsonb_build_object('changeId', p_change, 'outcome', v_outcome));
  return v_outcome;
end $$;

create function {{schema}}.close_change(p_change uuid, p_state text, p_actor uuid, p_at timestamptz) returns void language plpgsql as $$
declare v_version integer; v_tenant uuid; v_correlation uuid;
begin
  update {{schema}}.pending_change set state = p_state, decided_at = p_at where change_id = p_change
    returning version, tenant_id, correlation_id into v_version, v_tenant, v_correlation;
  perform {{schema}}.enqueue_event('approval.decided', p_actor, 'approval', p_change, v_version, v_tenant, v_correlation, p_at,
    jsonb_build_object('changeId', p_change, 'outcome', p_state));
end $$;

-- Port functions (SECURITY DEFINER; granted to the runtime role) ------------

-- Records a change the layer has authorised and routed. The database checks
-- again what it can know: the risk is never below Identity's, the
-- requirement never below the group's, no self-grant, a real delay.
create function {{schema}}.record_change(p jsonb) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  c {{schema}}.pending_change%rowtype;
  v_group {{schema}}."group"%rowtype;
  v_at timestamptz := (p ->> 'at')::timestamptz;
  v_floor integer;
begin
  c.type := p ->> 'type';
  c.risk := p ->> 'risk';
  if {{schema}}.declared_risk(c.type) is null then raise exception 'identity:unknown-change'; end if;
  if {{schema}}.risk_rank(c.risk) is null or {{schema}}.risk_rank(c.risk) < {{schema}}.risk_rank({{schema}}.declared_risk(c.type)) then
    raise exception 'identity:approval-floor';
  end if;
  select * into v_group from {{schema}}."group" where group_id = (p ->> 'groupId')::uuid;
  if not found or v_group.kind <> 'standard' then raise exception 'identity:unknown'; end if;
  c.change_id := {{schema}}.uuid_v7();
  c.tenant_id := v_group.tenant_id;
  c.group_id := v_group.group_id;
  c.requester_id := (p ->> 'requesterId')::uuid;
  c.beneficiary_id := (p ->> 'beneficiaryId')::uuid;
  if not exists (select 1 from {{schema}}.identity i where i.identity_id = c.requester_id and i.kind = 'person' and i.state = 'active') then
    raise exception 'identity:unknown';
  end if;
  if {{schema}}.confers(c.type) and c.beneficiary_id = c.requester_id then raise exception 'identity:self-grant'; end if;
  c.reason_code := p ->> 'reasonCode';
  c.reference := p ->> 'reference';
  if c.reason_code is null or (coalesce((v_group.settings -> 'approvals' ->> 'referenceRequired')::boolean, false) and c.reference is null) then
    raise exception 'identity:justification-missing';
  end if;
  c.target := p -> 'target';
  c.created_id := (p ->> 'createdId')::uuid;
  c.internal := coalesce(p -> 'internal', '{}'::jsonb);
  c.required_approvals := (p ->> 'requiredApprovals')::integer;
  v_floor := greatest(case when c.risk in ('high', 'critical') then 1 else 0 end,
    coalesce((v_group.settings -> 'approvals' -> 'required' ->> c.risk)::integer, 0));
  c.route := p ->> 'route';
  -- The owner fallbacks ask one owner of the parent group or of the tenant's root group.
  if (c.route in ('parent-owner', 'tenant-owner') and (c.required_approvals <> 1 or v_floor < 1))
    or (c.route not in ('parent-owner', 'tenant-owner') and c.required_approvals < v_floor) then
    raise exception 'identity:approval-floor';
  end if;
  c.approvals := '[]'::jsonb;
  c.delay_ends_at := (p ->> 'delayEndsAt')::timestamptz;
  c.expires_at := (p ->> 'expiresAt')::timestamptz;
  if c.route = 'published-delay'
    and c.delay_ends_at < v_at + (case when c.risk = 'critical' then interval '72 hours' else interval '24 hours' end) then
    raise exception 'identity:approval-floor';
  end if;
  if c.expires_at is not null and (c.expires_at <= v_at or c.expires_at > v_at + interval '14 days') then
    raise exception 'identity:approval-floor';
  end if;
  c.correlation_id := (p ->> 'correlationId')::uuid;
  c.created_at := v_at;
  c.version := 1;
  c.state := case c.route when 'none' then 'applied' when 'published-delay' then 'delayed' else 'awaiting-approval' end;
  c.decided_at := case when c.route = 'none' then v_at end;
  c.change_digest := {{schema}}.digest_of(c);
  insert into {{schema}}.pending_change select c.*;
  if c.route = 'none' then
    -- No approver needed: it applies now, or nothing is recorded at all.
    perform {{schema}}.apply_change(c, v_at);
  else
    perform {{schema}}.enqueue_event('approval.requested', c.requester_id, 'approval', c.change_id, 1, c.tenant_id, c.correlation_id, v_at,
      jsonb_build_object('changeId', c.change_id, 'changeType', c.type, 'groupId', c.group_id, 'risk', c.risk, 'route', c.route,
        'requiredApprovals', c.required_approvals, 'delayEndsAt', {{schema}}.iso(c.delay_ends_at)));
  end if;
  return {{schema}}.change_json(c);
end $$;

-- Records an approver's decision. For the approvers route, the layer has
-- just asked Authorisation (strong) that the approver qualifies; for the
-- owner fallbacks, ownership is checked here.
create function {{schema}}.record_decision(p_change uuid, p_approver uuid, p_decision text, p_assurance jsonb, p_digest text, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare c {{schema}}.pending_change%rowtype; v_lineage uuid[]; v_approved integer;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  if not found then raise exception 'identity:unknown'; end if;
  if c.state = 'awaiting-approval' and c.expires_at <= p_at then
    -- Recorded, not raised, so that the expiry survives; the layer reports it as a conflict.
    perform {{schema}}.close_change(p_change, 'expired', null, p_at);
    return (select {{schema}}.change_json(pc) from {{schema}}.pending_change pc where pc.change_id = p_change);
  end if;
  if c.state <> 'awaiting-approval' then raise exception 'identity:not-pending'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'identity:approval-refused'; end if;
  if p_approver = c.requester_id or p_approver is not distinct from c.beneficiary_id
    or not exists (select 1 from {{schema}}.identity i where i.identity_id = p_approver and i.kind = 'person' and i.state = 'active')
    or exists (select 1 from jsonb_array_elements(c.approvals) a where a ->> 'approverId' = p_approver::text) then
    raise exception 'identity:approval-refused';
  end if;
  if c.route in ('parent-owner', 'tenant-owner') then
    v_lineage := {{schema}}.lineage_of(c.group_id);
    if not {{schema}}.owns(p_approver, case c.route when 'parent-owner' then v_lineage[cardinality(v_lineage) - 1] else v_lineage[1] end) then
      raise exception 'identity:approval-refused';
    end if;
  end if;
  if p_digest is distinct from c.change_digest or {{schema}}.digest_of(c) <> c.change_digest then raise exception 'identity:change-differs'; end if;
  update {{schema}}.pending_change set approvals = approvals || jsonb_build_array(jsonb_build_object(
    'approverId', p_approver, 'decision', p_decision, 'decidedAt', {{schema}}.iso(p_at), 'assurance', p_assurance, 'changeDigest', p_digest))
    where change_id = p_change;
  if p_decision = 'reject' then
    perform {{schema}}.close_change(p_change, 'rejected', p_approver, p_at);
  else
    select count(*) into v_approved from {{schema}}.pending_change pc, jsonb_array_elements(pc.approvals) a
      where pc.change_id = p_change and a ->> 'decision' = 'approve';
    if v_approved >= c.required_approvals then perform {{schema}}.settle_change(p_change, p_at, p_approver); end if;
  end if;
  return (select {{schema}}.change_json(pc) from {{schema}}.pending_change pc where pc.change_id = p_change);
end $$;

-- The requester withdraws a change that has not taken effect.
create function {{schema}}.cancel_change(p_change uuid, p_requester uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare c {{schema}}.pending_change%rowtype;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  if not found or c.requester_id <> p_requester then raise exception 'identity:unknown'; end if;
  if c.state not in ('awaiting-approval', 'delayed') then raise exception 'identity:not-pending'; end if;
  perform {{schema}}.close_change(p_change, 'cancelled', p_requester, p_at);
  return (select {{schema}}.change_json(pc) from {{schema}}.pending_change pc where pc.change_id = p_change);
end $$;

-- Maintenance: expires changes nobody approved in time, and applies those
-- whose published delay has ended.
create function {{schema}}.run_due_changes(p_at timestamptz, p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r record; v_expired integer := 0; v_applied integer := 0; v_rejected integer := 0;
begin
  for r in select change_id from {{schema}}.pending_change where state = 'awaiting-approval' and expires_at <= p_at
    order by expires_at limit p_limit for update skip locked
  loop
    perform {{schema}}.close_change(r.change_id, 'expired', null, p_at);
    v_expired := v_expired + 1;
  end loop;
  for r in select change_id from {{schema}}.pending_change where state = 'delayed' and delay_ends_at <= p_at
    order by delay_ends_at limit p_limit for update skip locked
  loop
    if {{schema}}.settle_change(r.change_id, p_at, null) = 'applied' then v_applied := v_applied + 1; else v_rejected := v_rejected + 1; end if;
  end loop;
  return jsonb_build_object('expired', v_expired, 'applied', v_applied, 'rejected', v_rejected);
end $$;

create function {{schema}}.get_change(p_change uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.change_json(c) from {{schema}}.pending_change c where c.change_id = p_change
$$;

-- For routing: active owners of a group other than the given identities.
create function {{schema}}.count_active_owners(p_group uuid, p_excluding uuid[])
returns integer language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.active_owner_count(p_group, p_excluding)
$$;

create function {{schema}}.is_active_owner(p_identity uuid, p_group uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.owns(p_identity, p_group)
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
-- Tenants are provisioned with the migration role, by the operator's procedure.
revoke execute on function {{schema}}.create_tenant(text, text, text, uuid, timestamptz) from {{runtime}};
grant select on {{schema}}.pending_change to {{runtime}};
grant execute on function
  {{schema}}.record_change(jsonb),
  {{schema}}.record_decision(uuid, uuid, text, jsonb, text, timestamptz),
  {{schema}}.cancel_change(uuid, uuid, timestamptz),
  {{schema}}.run_due_changes(timestamptz, integer),
  {{schema}}.get_change(uuid),
  {{schema}}.count_active_owners(uuid, uuid[]),
  {{schema}}.is_active_owner(uuid, uuid)
to {{runtime}};
`,
  },
  {
    id: '0004_invitations_join_requests',
    sql: `
-- Invitations ---------------------------------------------------------------
-- Only the token's SHA-256 digest is stored; the address never reaches
-- Identity. Created, accepted, declined, revoked, confirmed and expired only
-- through the SECURITY DEFINER functions below; the runtime role may read
-- invitations of the tenants set for its transaction.

create table {{schema}}.invitation (
  invitation_id uuid primary key,
  group_id uuid not null references {{schema}}."group" (group_id),
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  kind text not null check (kind in ('member', 'guest')),
  invitee_identity_id uuid references {{schema}}.identity (identity_id),
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  invited_by uuid not null references {{schema}}.identity (identity_id),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  membership_starts_at timestamptz,
  membership_ends_at timestamptz,
  requires_confirmation boolean not null,
  state text not null check (state in ('open', 'awaiting-confirmation', 'accepted', 'refused', 'declined', 'revoked', 'expired')),
  accepted_by uuid references {{schema}}.identity (identity_id),
  accepted_at timestamptz,
  confirmed_by uuid references {{schema}}.identity (identity_id),
  decided_at timestamptz,
  version integer not null check (version >= 1),
  check (not (requires_confirmation and invitee_identity_id is not null)),
  check (state <> 'awaiting-confirmation' or requires_confirmation),
  check (confirmed_by is null or confirmed_by <> accepted_by),
  check (membership_ends_at is null or membership_starts_at is null or membership_ends_at > membership_starts_at)
);
create index invitation_inviter_idx on {{schema}}.invitation (invited_by, created_at);
create index invitation_group_idx on {{schema}}.invitation (group_id, created_at);
create index invitation_open_idx on {{schema}}.invitation (expires_at) where state in ('open', 'awaiting-confirmation');

-- Who tried to accept or decline, for the per-identity rate limit. Never granted.
create table {{schema}}.acceptance_attempt (
  identity_id uuid not null,
  attempted_at timestamptz not null
);
create index acceptance_attempt_idx on {{schema}}.acceptance_attempt (identity_id, attempted_at);

create table {{schema}}.join_request (
  join_request_id uuid primary key,
  group_id uuid not null references {{schema}}."group" (group_id),
  tenant_id uuid not null references {{schema}}.tenant (tenant_id),
  identity_id uuid not null references {{schema}}.identity (identity_id),
  state text not null check (state in ('open', 'approved', 'refused', 'withdrawn', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  decided_by uuid references {{schema}}.identity (identity_id),
  decided_at timestamptz,
  version integer not null check (version >= 1),
  check (decided_by is null or decided_by <> identity_id),
  check ((state = 'open') = (decided_at is null))
);
create unique index join_request_one_open on {{schema}}.join_request (identity_id, group_id) where state = 'open';
create index join_request_group_idx on {{schema}}.join_request (group_id, created_at);
create index join_request_open_idx on {{schema}}.join_request (expires_at) where state = 'open';

alter table {{schema}}.invitation enable row level security;
alter table {{schema}}.join_request enable row level security;
create policy tenant_isolation on {{schema}}.invitation using (tenant_id = any ({{schema}}.current_tenant_ids()));
create policy tenant_isolation on {{schema}}.join_request using (tenant_id = any ({{schema}}.current_tenant_ids()));
create trigger invitation_version before update on {{schema}}.invitation for each row execute function {{schema}}.bump_version();
create trigger join_request_version before update on {{schema}}.join_request for each row execute function {{schema}}.bump_version();

create function {{schema}}.invitation_json(i {{schema}}.invitation) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'invitationId', i.invitation_id, 'groupId', i.group_id, 'tenantId', i.tenant_id, 'kind', i.kind,
    'inviteeIdentityId', i.invitee_identity_id, 'tokenDigest', i.token_digest, 'invitedBy', i.invited_by,
    'createdAt', {{schema}}.iso(i.created_at), 'expiresAt', {{schema}}.iso(i.expires_at),
    'membershipStartsAt', {{schema}}.iso(i.membership_starts_at), 'membershipEndsAt', {{schema}}.iso(i.membership_ends_at),
    'requiresConfirmation', i.requires_confirmation, 'state', i.state, 'acceptedBy', i.accepted_by,
    'acceptedAt', {{schema}}.iso(i.accepted_at), 'confirmedBy', i.confirmed_by, 'decidedAt', {{schema}}.iso(i.decided_at), 'version', i.version)
$$;

create function {{schema}}.join_request_json(r {{schema}}.join_request) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'joinRequestId', r.join_request_id, 'groupId', r.group_id, 'tenantId', r.tenant_id, 'identityId', r.identity_id,
    'state', r.state, 'createdAt', {{schema}}.iso(r.created_at), 'expiresAt', {{schema}}.iso(r.expires_at),
    'decidedBy', r.decided_by, 'decidedAt', {{schema}}.iso(r.decided_at), 'version', r.version)
$$;

-- Rules (internal) ------------------------------------------------------------

create function {{schema}}.set_context(p_actor uuid, p_correlation uuid, p_at timestamptz) returns void language sql volatile as $$
  select set_config('identity.actor_id', coalesce(p_actor::text, ''), true), set_config('identity.correlation_id', p_correlation::text, true),
    set_config('identity.at', p_at::text, true), set_config('identity.change_id', '', true)
$$;

create function {{schema}}.is_active_person(p_identity uuid) returns boolean language sql stable as $$
  select exists (select 1 from {{schema}}.identity i where i.identity_id = p_identity and i.kind = 'person' and i.state = 'active')
$$;

-- A group that can take new members now: standard, active, in an active tenant.
create function {{schema}}.open_for_members(p_group uuid) returns boolean language sql stable as $$
  select exists (select 1 from {{schema}}."group" g join {{schema}}.tenant t on t.tenant_id = g.tenant_id
    where g.group_id = p_group and g.kind = 'standard' and g.state = 'active' and t.state = 'active')
$$;

create function {{schema}}.has_live_membership(p_identity uuid, p_group uuid) returns boolean language sql stable as $$
  select exists (select 1 from {{schema}}.membership m where m.identity_id = p_identity and m.group_id = p_group and m.state <> 'ended')
$$;

-- In the tenant: its home tenant, or a membership in effect there.
create function {{schema}}.in_tenant(p_identity uuid, p_tenant uuid, p_at timestamptz) returns boolean language sql stable as $$
  select exists (select 1 from {{schema}}.identity i where i.identity_id = p_identity and i.home_tenant_id = p_tenant)
    or exists (select 1 from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
      where m.identity_id = p_identity and m.tenant_id = p_tenant and g.kind = 'standard' and m.state in ('active', 'paused')
        and m.starts_at <= p_at and (m.ends_at is null or m.ends_at > p_at))
$$;

-- Creates the membership an invitation or join request leads to. Returns
-- false, changing nothing, when it cannot be created now.
create function {{schema}}.admit(p_identity uuid, p_group uuid, p_kind text, p_starts timestamptz, p_ends timestamptz, p_at timestamptz) returns boolean language plpgsql as $$
declare v_group {{schema}}."group"%rowtype; v_starts timestamptz := coalesce(p_starts, p_at); v_ends timestamptz := p_ends;
begin
  if not {{schema}}.open_for_members(p_group) or not {{schema}}.is_active_person(p_identity) or {{schema}}.has_live_membership(p_identity, p_group) then
    return false;
  end if;
  select * into v_group from {{schema}}."group" where group_id = p_group;
  if p_kind = 'guest' then
    if not coalesce((v_group.settings -> 'guests' ->> 'allowed')::boolean, false) then return false; end if;
    v_ends := coalesce(v_ends, greatest(v_starts, p_at) + make_interval(days => coalesce((v_group.settings -> 'guests' ->> 'termDays')::integer, 90)));
  end if;
  if v_ends is not null and (v_ends <= p_at or v_ends <= v_starts) then return false; end if;
  insert into {{schema}}.membership (membership_id, identity_id, group_id, tenant_id, kind, state, owner, founding_owner, starts_at, ends_at, ended_at, end_reason, reason_code, created_at, version)
    values ({{schema}}.uuid_v7(), p_identity, p_group, v_group.tenant_id, p_kind, 'active', false, false, v_starts, v_ends, null, null, null, p_at, 1);
  return true;
end $$;

create function {{schema}}.attempt_allowed(p_identity uuid, p_at timestamptz, p_limit integer) returns boolean language plpgsql as $$
begin
  insert into {{schema}}.acceptance_attempt values (p_identity, p_at);
  return (select count(*) from {{schema}}.acceptance_attempt a where a.identity_id = p_identity and a.attempted_at > p_at - interval '1 hour') <= p_limit;
end $$;

-- Invitation functions (SECURITY DEFINER; granted) ----------------------------

create function {{schema}}.create_invitation(p jsonb) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  i {{schema}}.invitation%rowtype;
  v_group {{schema}}."group"%rowtype;
  v_at timestamptz := (p ->> 'at')::timestamptz;
begin
  i.invited_by := (p ->> 'invitedBy')::uuid;
  perform pg_advisory_xact_lock(hashtext('identity-invitations:' || i.invited_by::text));
  select * into v_group from {{schema}}."group" where group_id = (p ->> 'groupId')::uuid and kind = 'standard';
  if not found then raise exception 'identity:unknown'; end if;
  if not {{schema}}.is_active_person(i.invited_by) then raise exception 'identity:unknown'; end if;
  if not {{schema}}.open_for_members(v_group.group_id) then raise exception 'identity:group-not-active'; end if;
  i.kind := p ->> 'kind';
  if i.kind = 'guest' and not coalesce((v_group.settings -> 'guests' ->> 'allowed')::boolean, false) then raise exception 'identity:guests-not-allowed'; end if;
  i.invitee_identity_id := (p ->> 'inviteeIdentityId')::uuid;
  if i.invitee_identity_id is not null then
    if i.invitee_identity_id = i.invited_by then raise exception 'identity:self-grant'; end if;
    if not exists (select 1 from {{schema}}.identity x where x.identity_id = i.invitee_identity_id and x.kind = 'person' and x.state in ('active', 'paused')) then
      raise exception 'identity:unknown';
    end if;
    if {{schema}}.has_live_membership(i.invitee_identity_id, v_group.group_id) then raise exception 'identity:already-member'; end if;
  end if;
  i.membership_starts_at := (p ->> 'membershipStartsAt')::timestamptz;
  i.membership_ends_at := (p ->> 'membershipEndsAt')::timestamptz;
  if i.membership_ends_at is not null and (i.membership_ends_at <= v_at or i.membership_ends_at <= coalesce(i.membership_starts_at, v_at)) then
    raise exception 'identity:invalid-dates';
  end if;
  if i.kind = 'guest' and i.membership_ends_at is not null and i.membership_ends_at >
    greatest(v_at, coalesce(i.membership_starts_at, v_at)) + make_interval(days => (v_group.settings -> 'guests' ->> 'termDays')::integer) then
    raise exception 'identity:guest-term';
  end if;
  if (select count(*) from {{schema}}.invitation x where x.invited_by = i.invited_by and x.created_at > v_at - interval '1 hour') >= (p ->> 'perInviterPerHour')::integer
    or (select count(*) from {{schema}}.invitation x where x.group_id = v_group.group_id and x.created_at > v_at - interval '1 day') >= (p ->> 'perGroupPerDay')::integer then
    raise exception 'identity:rate-limited';
  end if;
  i.invitation_id := {{schema}}.uuid_v7();
  i.group_id := v_group.group_id;
  i.tenant_id := v_group.tenant_id;
  i.token_digest := p ->> 'tokenDigest';
  i.created_at := v_at;
  i.expires_at := (p ->> 'expiresAt')::timestamptz;
  if i.expires_at <= v_at or i.expires_at > v_at + interval '30 days' then raise exception 'identity:invalid-dates'; end if;
  i.requires_confirmation := i.invitee_identity_id is null and v_group.settings -> 'joining' -> 'invitationAcceptance' ->> i.kind = 'confirm';
  i.state := 'open';
  i.version := 1;
  insert into {{schema}}.invitation select i.*;
  return {{schema}}.invitation_json(i);
end $$;

-- The token's holder accepts. Returns 'rate-limited', or 'done' whatever
-- else happened, so that nothing can be learnt by probing.
create function {{schema}}.accept_invitation(p_digest text, p_identity uuid, p_correlation uuid, p_at timestamptz, p_limit integer)
returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare i {{schema}}.invitation%rowtype; v_version integer; v_waiting boolean;
begin
  if not {{schema}}.attempt_allowed(p_identity, p_at, p_limit) then return 'rate-limited'; end if;
  select * into i from {{schema}}.invitation where token_digest = p_digest for update;
  -- Nobody accepts their own invitation (no self-grant), nor one bound to someone else.
  if not found or i.state <> 'open' or i.expires_at <= p_at or i.invited_by = p_identity
    or (i.invitee_identity_id is not null and i.invitee_identity_id <> p_identity)
    or not {{schema}}.open_for_members(i.group_id) or not {{schema}}.is_active_person(p_identity)
    or {{schema}}.has_live_membership(p_identity, i.group_id) then
    return 'done';
  end if;
  perform {{schema}}.set_context(p_identity, p_correlation, p_at);
  v_waiting := i.requires_confirmation;
  if v_waiting then
    update {{schema}}.invitation set state = 'awaiting-confirmation', accepted_by = p_identity, accepted_at = p_at
      where invitation_id = i.invitation_id returning version into v_version;
  else
    if not {{schema}}.admit(p_identity, i.group_id, i.kind, i.membership_starts_at, i.membership_ends_at, p_at) then return 'done'; end if;
    update {{schema}}.invitation set state = 'accepted', accepted_by = p_identity, accepted_at = p_at, decided_at = p_at
      where invitation_id = i.invitation_id returning version into v_version;
  end if;
  perform {{schema}}.enqueue_event('invitation.accepted', p_identity, 'invitation', i.invitation_id, v_version, i.tenant_id, p_correlation, p_at,
    jsonb_build_object('invitationId', i.invitation_id, 'groupId', i.group_id, 'invitedBy', i.invited_by, 'acceptedBy', p_identity, 'awaitingConfirmation', v_waiting));
  return 'done';
end $$;

create function {{schema}}.decline_invitation(p_digest text, p_identity uuid, p_at timestamptz, p_limit integer)
returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare i {{schema}}.invitation%rowtype;
begin
  if not {{schema}}.attempt_allowed(p_identity, p_at, p_limit) then return 'rate-limited'; end if;
  select * into i from {{schema}}.invitation where token_digest = p_digest for update;
  if found and i.state = 'open' and i.expires_at > p_at and (i.invitee_identity_id is null or i.invitee_identity_id = p_identity) then
    update {{schema}}.invitation set state = 'declined', decided_at = p_at where invitation_id = i.invitation_id;
  end if;
  return 'done';
end $$;

create function {{schema}}.get_invitation(p_invitation uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.invitation_json(i) from {{schema}}.invitation i where i.invitation_id = p_invitation
$$;

-- An administrator, already authorised by the layer, revokes an invitation not yet decided.
create function {{schema}}.revoke_invitation(p_invitation uuid, p_actor uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare i {{schema}}.invitation%rowtype;
begin
  select * into i from {{schema}}.invitation where invitation_id = p_invitation for update;
  if not found or not {{schema}}.is_active_person(p_actor) then raise exception 'identity:unknown'; end if;
  if i.state not in ('open', 'awaiting-confirmation') then raise exception 'identity:not-pending'; end if;
  update {{schema}}.invitation set state = 'revoked', decided_at = p_at where invitation_id = p_invitation returning * into i;
  return {{schema}}.invitation_json(i);
end $$;

-- An administrator, already authorised by the layer, confirms or refuses who accepted.
create function {{schema}}.decide_invitation(p_invitation uuid, p_admin uuid, p_decision text, p_correlation uuid, p_at timestamptz, p_confirm_days integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare i {{schema}}.invitation%rowtype; v_version integer;
begin
  select * into i from {{schema}}.invitation where invitation_id = p_invitation for update;
  if not found or not {{schema}}.is_active_person(p_admin) then raise exception 'identity:unknown'; end if;
  if i.state = 'awaiting-confirmation' and i.accepted_at + make_interval(days => p_confirm_days) <= p_at then
    update {{schema}}.invitation set state = 'expired', decided_at = p_at where invitation_id = p_invitation returning * into i;
    return {{schema}}.invitation_json(i);
  end if;
  if i.state <> 'awaiting-confirmation' then raise exception 'identity:not-pending'; end if;
  if i.accepted_by = p_admin then raise exception 'identity:own-acceptance'; end if;
  perform {{schema}}.set_context(p_admin, p_correlation, p_at);
  if p_decision = 'confirm' then
    if not {{schema}}.admit(i.accepted_by, i.group_id, i.kind, i.membership_starts_at, i.membership_ends_at, p_at) then
      raise exception 'identity:not-eligible';
    end if;
    update {{schema}}.invitation set state = 'accepted', confirmed_by = p_admin, decided_at = p_at where invitation_id = p_invitation returning * into i;
  elsif p_decision = 'refuse' then
    update {{schema}}.invitation set state = 'refused', confirmed_by = p_admin, decided_at = p_at where invitation_id = p_invitation returning * into i;
    perform {{schema}}.enqueue_event('invitation.refused', p_admin, 'invitation', i.invitation_id, i.version, i.tenant_id, p_correlation, p_at,
      jsonb_build_object('invitationId', i.invitation_id, 'groupId', i.group_id, 'refusedBy', p_admin));
  else
    raise exception 'identity:unknown';
  end if;
  return {{schema}}.invitation_json(i);
end $$;

-- The inviting tenant of an open, unbound invitation, for a sign-up's home tenant. Null otherwise.
create function {{schema}}.invitation_home_tenant(p_digest text, p_at timestamptz) returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.tenant_id from {{schema}}.invitation i join {{schema}}.tenant t on t.tenant_id = i.tenant_id
  where i.token_digest = p_digest and i.state = 'open' and i.expires_at > p_at and i.invitee_identity_id is null and t.state = 'active'
$$;

-- Join requests (SECURITY DEFINER; granted) -------------------------------------

-- Someone in the group's tenant asks to join: joins at once where joining is
-- open, otherwise records a request where requests are allowed.
create function {{schema}}.request_join(p_group uuid, p_identity uuid, p_correlation uuid, p_at timestamptz, p_expires timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_group {{schema}}."group"%rowtype; r {{schema}}.join_request%rowtype;
begin
  select * into v_group from {{schema}}."group" where group_id = p_group and kind = 'standard';
  if not found or not {{schema}}.is_active_person(p_identity) or not {{schema}}.in_tenant(p_identity, v_group.tenant_id, p_at) then
    raise exception 'identity:unknown';
  end if;
  if not {{schema}}.open_for_members(p_group) then raise exception 'identity:group-not-active'; end if;
  if {{schema}}.has_live_membership(p_identity, p_group) then raise exception 'identity:already-member'; end if;
  perform {{schema}}.set_context(p_identity, p_correlation, p_at);
  if coalesce((v_group.settings -> 'joining' ->> 'open')::boolean, false) then
    perform {{schema}}.admit(p_identity, p_group, 'member', null, null, p_at);
    return jsonb_build_object('outcome', 'joined', 'joinRequestId', null);
  end if;
  if not coalesce((v_group.settings -> 'joining' ->> 'requests')::boolean, false) then raise exception 'identity:joining-closed'; end if;
  select * into r from {{schema}}.join_request where identity_id = p_identity and group_id = p_group and state = 'open' and expires_at > p_at;
  if found then return jsonb_build_object('outcome', 'requested', 'joinRequestId', r.join_request_id); end if;
  -- A request past its time that maintenance has not yet expired is expired now, and announced.
  for r in select * from {{schema}}.join_request where identity_id = p_identity and group_id = p_group and state = 'open' for update loop
    perform {{schema}}.close_join_request(r, 'expired', null, null, p_correlation, p_at);
  end loop;
  insert into {{schema}}.join_request values ({{schema}}.uuid_v7(), p_group, v_group.tenant_id, p_identity, 'open', p_at, p_expires, null, null, 1) returning * into r;
  perform {{schema}}.enqueue_event('join-request.created', p_identity, 'join-request', r.join_request_id, 1, r.tenant_id, p_correlation, p_at,
    jsonb_build_object('joinRequestId', r.join_request_id, 'groupId', p_group, 'identityId', p_identity));
  return jsonb_build_object('outcome', 'requested', 'joinRequestId', r.join_request_id);
end $$;

create function {{schema}}.close_join_request(r {{schema}}.join_request, p_state text, p_actor uuid, p_decider uuid, p_correlation uuid, p_at timestamptz)
returns {{schema}}.join_request language plpgsql as $$
declare v {{schema}}.join_request%rowtype;
begin
  update {{schema}}.join_request set state = p_state, decided_by = p_decider, decided_at = p_at where join_request_id = r.join_request_id returning * into v;
  perform {{schema}}.enqueue_event('join-request.decided', p_actor, 'join-request', v.join_request_id, v.version, v.tenant_id, p_correlation, p_at,
    jsonb_build_object('joinRequestId', v.join_request_id, 'groupId', v.group_id, 'identityId', v.identity_id, 'outcome', p_state));
  return v;
end $$;

create function {{schema}}.withdraw_join_request(p_request uuid, p_identity uuid, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r {{schema}}.join_request%rowtype;
begin
  select * into r from {{schema}}.join_request where join_request_id = p_request for update;
  if not found or r.identity_id <> p_identity then raise exception 'identity:unknown'; end if;
  if r.state <> 'open' then raise exception 'identity:not-pending'; end if;
  return {{schema}}.join_request_json({{schema}}.close_join_request(r, 'withdrawn', p_identity, null, p_correlation, p_at));
end $$;

-- An administrator, already authorised by the layer, approves or refuses.
create function {{schema}}.decide_join_request(p_request uuid, p_admin uuid, p_decision text, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r {{schema}}.join_request%rowtype;
begin
  select * into r from {{schema}}.join_request where join_request_id = p_request for update;
  if not found or not {{schema}}.is_active_person(p_admin) then raise exception 'identity:unknown'; end if;
  if r.state = 'open' and r.expires_at <= p_at then
    return {{schema}}.join_request_json({{schema}}.close_join_request(r, 'expired', null, null, p_correlation, p_at));
  end if;
  if r.state <> 'open' then raise exception 'identity:not-pending'; end if;
  if r.identity_id = p_admin then raise exception 'identity:own-request'; end if;
  perform {{schema}}.set_context(p_admin, p_correlation, p_at);
  if p_decision = 'approve' then
    if not {{schema}}.admit(r.identity_id, r.group_id, 'member', null, null, p_at) then raise exception 'identity:not-eligible'; end if;
    return {{schema}}.join_request_json({{schema}}.close_join_request(r, 'approved', p_admin, p_admin, p_correlation, p_at));
  elsif p_decision = 'refuse' then
    return {{schema}}.join_request_json({{schema}}.close_join_request(r, 'refused', p_admin, p_admin, p_correlation, p_at));
  end if;
  raise exception 'identity:unknown';
end $$;

create function {{schema}}.get_join_request(p_request uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.join_request_json(r) from {{schema}}.join_request r where r.join_request_id = p_request
$$;

-- Maintenance: invitations and join requests past their time, and old attempts.
create function {{schema}}.expire_joining(p_correlation uuid, p_at timestamptz, p_confirm_days integer, p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r {{schema}}.join_request%rowtype; v_invitations integer; v_requests integer := 0;
begin
  with due as (
    select invitation_id from {{schema}}.invitation
    where (state = 'open' and expires_at <= p_at) or (state = 'awaiting-confirmation' and accepted_at + make_interval(days => p_confirm_days) <= p_at)
    order by expires_at limit p_limit for update skip locked
  )
  update {{schema}}.invitation i set state = 'expired', decided_at = p_at from due where i.invitation_id = due.invitation_id;
  get diagnostics v_invitations = row_count;
  for r in select * from {{schema}}.join_request where state = 'open' and expires_at <= p_at order by expires_at limit p_limit for update skip locked loop
    perform {{schema}}.close_join_request(r, 'expired', null, null, p_correlation, p_at);
    v_requests := v_requests + 1;
  end loop;
  delete from {{schema}}.acceptance_attempt where attempted_at < p_at - interval '1 day';
  return jsonb_build_object('invitations', v_invitations, 'joinRequests', v_requests);
end $$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
grant select on {{schema}}.invitation, {{schema}}.join_request to {{runtime}};
grant execute on function
  {{schema}}.iso(timestamptz),
  {{schema}}.invitation_json({{schema}}.invitation),
  {{schema}}.join_request_json({{schema}}.join_request),
  {{schema}}.create_invitation(jsonb),
  {{schema}}.accept_invitation(text, uuid, uuid, timestamptz, integer),
  {{schema}}.decline_invitation(text, uuid, timestamptz, integer),
  {{schema}}.get_invitation(uuid),
  {{schema}}.revoke_invitation(uuid, uuid, timestamptz),
  {{schema}}.decide_invitation(uuid, uuid, text, uuid, timestamptz, integer),
  {{schema}}.invitation_home_tenant(text, timestamptz),
  {{schema}}.request_join(uuid, uuid, uuid, timestamptz, timestamptz),
  {{schema}}.withdraw_join_request(uuid, uuid, uuid, timestamptz),
  {{schema}}.decide_join_request(uuid, uuid, text, uuid, timestamptz),
  {{schema}}.get_join_request(uuid),
  {{schema}}.expire_joining(uuid, timestamptz, integer, integer)
to {{runtime}};
`,
  },
  {
    id: '0005_lifecycle_recovery_break_glass',
    sql: `
-- Orphaned groups -------------------------------------------------------------
-- A standard group with no owner in effect is recorded orphaned, and active
-- again when one returns, whenever an owner's membership or identity
-- changes. Governance changes need an active group; only recovery and
-- break-glass act on an orphaned one.

create function {{schema}}.reconcile_ownership(p_group uuid) returns void language plpgsql as $$
declare
  g {{schema}}."group"%rowtype;
  v_version integer;
  v_correlation uuid := coalesce({{schema}}.context_uuid('identity.correlation_id'), {{schema}}.uuid_v7());
  v_at timestamptz := {{schema}}.context_at();
begin
  select * into g from {{schema}}."group" where group_id = p_group and kind = 'standard' for update;
  if not found or g.state = 'archived' then return; end if;
  if g.state = 'active' and {{schema}}.active_owner_count(p_group, '{}') = 0 then
    update {{schema}}."group" set state = 'orphaned' where group_id = p_group returning version into v_version;
    perform {{schema}}.enqueue_event('group.orphaned', {{schema}}.context_uuid('identity.actor_id'), 'group', p_group, v_version, g.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', p_group));
  elsif g.state = 'orphaned' and {{schema}}.active_owner_count(p_group, '{}') > 0 then
    update {{schema}}."group" set state = 'active' where group_id = p_group returning version into v_version;
    perform {{schema}}.enqueue_event('group.recovered', {{schema}}.context_uuid('identity.actor_id'), 'group', p_group, v_version, g.tenant_id, v_correlation, v_at,
      jsonb_build_object('groupId', p_group, 'changeId', {{schema}}.context_uuid('identity.change_id'),
        'breakGlassReviewId', {{schema}}.context_uuid('identity.break_glass_review_id')));
  end if;
end $$;

create function {{schema}}.membership_ownership() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform {{schema}}.reconcile_ownership(new.group_id);
  return new;
end $$;

-- Archiving ends memberships on its way to archiving the group: not an orphaning.
create trigger membership_ownership after update on {{schema}}.membership
  for each row when ((old.owner or new.owner) and new.end_reason is distinct from 'group-archived')
  execute function {{schema}}.membership_ownership();

create function {{schema}}.identity_ownership() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record;
begin
  for r in select distinct m.group_id from {{schema}}.membership m where m.identity_id = new.identity_id and m.owner and m.state <> 'ended' loop
    perform {{schema}}.reconcile_ownership(r.group_id);
  end loop;
  return new;
end $$;

create trigger identity_ownership after update of state on {{schema}}.identity
  for each row when (old.state is distinct from new.state) execute function {{schema}}.identity_ownership();

-- Membership events name a break-glass review as well as a change.
create or replace function {{schema}}.membership_events() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_correlation uuid := {{schema}}.context_uuid('identity.correlation_id');
  v_actor uuid := {{schema}}.context_uuid('identity.actor_id');
  v_change uuid := {{schema}}.context_uuid('identity.change_id');
  v_review uuid := {{schema}}.context_uuid('identity.break_glass_review_id');
  v_at timestamptz := {{schema}}.context_at();
  v_base jsonb := jsonb_build_object('membershipId', new.membership_id, 'identityId', new.identity_id, 'groupId', new.group_id);
  v_type text;
  v_data jsonb;
begin
  -- A personal group's membership follows its identity; provisioning announces it.
  if exists (select 1 from {{schema}}."group" g where g.group_id = new.group_id and g.kind = 'personal') then return new; end if;
  if v_correlation is null then raise exception 'identity:correlation-required'; end if;
  if tg_op = 'INSERT' then
    v_type := 'membership.added';
    v_data := v_base || jsonb_build_object('kind', new.kind, 'owner', new.owner, 'startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  elsif new.state is distinct from old.state then
    if new.state = 'ended' then
      v_type := 'membership.ended';
      v_data := v_base || jsonb_build_object('endReason', new.end_reason, 'reasonCode', new.reason_code);
    elsif new.state = 'paused' then
      v_type := 'membership.paused'; v_data := v_base;
    elsif new.state = 'suspended' then
      v_type := 'membership.suspended';
      v_data := v_base || jsonb_build_object('reasonCode', new.reason_code, 'changeId', v_change, 'breakGlassReviewId', v_review);
    elsif old.state = 'paused' then
      v_type := 'membership.resumed'; v_data := v_base;
    else
      v_type := 'membership.reinstated'; v_data := v_base || jsonb_build_object('changeId', v_change);
    end if;
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_type := 'membership.dates-changed';
    v_data := v_base || jsonb_build_object('startsAt', {{schema}}.iso(new.starts_at), 'endsAt', {{schema}}.iso(new.ends_at));
  else
    return new;
  end if;
  perform {{schema}}.enqueue_event(v_type, v_actor, 'membership', new.membership_id, new.version, new.tenant_id, v_correlation, v_at, v_data);
  return new;
end $$;

-- The identity lifecycle (SECURITY DEFINER; granted) --------------------------
-- Actions reserved to the person; the layer checks reauthentication.

create function {{schema}}.last_owner_of(p_identity uuid) returns uuid[] language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct m.group_id order by m.group_id), '{}'::uuid[])
  from {{schema}}.membership m join {{schema}}."group" g on g.group_id = m.group_id
  where m.identity_id = p_identity and m.owner and m.state = 'active' and g.kind = 'standard' and g.state = 'active'
    and {{schema}}.active_owner_count(m.group_id, array[p_identity]) = 0
$$;

create function {{schema}}.change_identity_state(p_identity uuid, p_from text[], p_to text, p_event text, p_correlation uuid, p_at timestamptz, p_deadline timestamptz)
returns jsonb language plpgsql as $$
declare i {{schema}}.identity%rowtype; v_state text; v_previous text;
begin
  select * into i from {{schema}}.identity where identity_id = p_identity for update;
  if not found or i.kind <> 'person' then raise exception 'identity:unknown'; end if;
  if not (i.state = any (p_from)) then raise exception 'identity:not-eligible'; end if;
  perform {{schema}}.set_context(p_identity, p_correlation, p_at);
  if p_to = 'previous' then
    v_state := coalesce(i.previous_state, 'active');
    v_previous := null;
  elsif p_to = 'closure-pending' then
    v_state := p_to;
    v_previous := i.state;
  else
    v_state := p_to;
    v_previous := i.previous_state;
  end if;
  update {{schema}}.identity set state = v_state, previous_state = v_previous, deadline_at = p_deadline, state_changed_at = p_at, version = version + 1
    where identity_id = p_identity;
  perform {{schema}}.enqueue_event(p_event, p_identity, 'identity', p_identity, i.version + 1, null, p_correlation, p_at,
    case when p_event = 'identity.closure-requested' then jsonb_build_object('identityId', p_identity, 'closesAt', {{schema}}.iso(p_deadline))
      else jsonb_build_object('identityId', p_identity) end);
  return jsonb_build_object('identityId', p_identity, 'state', v_state);
end $$;

create function {{schema}}.pause_identity(p_identity uuid, p_correlation uuid, p_at timestamptz)
returns jsonb language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.change_identity_state(p_identity, array['active'], 'paused', 'identity.paused', p_correlation, p_at, null)
$$;

create function {{schema}}.resume_identity(p_identity uuid, p_correlation uuid, p_at timestamptz)
returns jsonb language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.change_identity_state(p_identity, array['paused'], 'active', 'identity.resumed', p_correlation, p_at, null)
$$;

-- Closure needs the person not to be the last active owner of a group,
-- unless they choose to leave those groups to recovery; the grace period is
-- never shorter than 7 days.
create function {{schema}}.request_closure(p_identity uuid, p_closes_at timestamptz, p_leave_orphaned boolean, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_closes_at < p_at + interval '7 days' then raise exception 'identity:invalid-dates'; end if;
  if not p_leave_orphaned and cardinality({{schema}}.last_owner_of(p_identity)) > 0 then raise exception 'identity:last-owner'; end if;
  return {{schema}}.change_identity_state(p_identity, array['active', 'paused', 'suspended'], 'closure-pending', 'identity.closure-requested', p_correlation, p_at, p_closes_at);
end $$;

create function {{schema}}.cancel_closure(p_identity uuid, p_correlation uuid, p_at timestamptz)
returns jsonb language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.change_identity_state(p_identity, array['closure-pending'], 'previous', 'identity.closure-cancelled', p_correlation, p_at, null)
$$;

-- Maintenance: closes identities at the end of their grace period. Their
-- memberships end, their pending changes, invitations and join requests are
-- withdrawn, and groups they alone owned become orphaned.
create function {{schema}}.close_due_identities(p_correlation uuid, p_at timestamptz, p_limit integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare i record; c record; r {{schema}}.join_request%rowtype; n integer := 0;
begin
  for i in select identity_id, version, personal_group_id from {{schema}}.identity
    where state = 'closure-pending' and deadline_at <= p_at order by deadline_at limit p_limit for update skip locked
  loop
    perform {{schema}}.set_context(null, p_correlation, p_at);
    update {{schema}}.membership set state = 'ended', ended_at = p_at, end_reason = 'identity-closed', reason_code = null
      where identity_id = i.identity_id and state <> 'ended';
    for c in select change_id from {{schema}}.pending_change where requester_id = i.identity_id and state in ('awaiting-approval', 'delayed') for update loop
      perform {{schema}}.close_change(c.change_id, 'cancelled', null, p_at);
    end loop;
    update {{schema}}.invitation set state = 'revoked', decided_at = p_at
      where state in ('open', 'awaiting-confirmation') and (invited_by = i.identity_id or accepted_by = i.identity_id or invitee_identity_id = i.identity_id);
    for r in select * from {{schema}}.join_request where identity_id = i.identity_id and state = 'open' for update loop
      perform {{schema}}.close_join_request(r, 'withdrawn', null, null, p_correlation, p_at);
    end loop;
    update {{schema}}.identity set state = 'closed', previous_state = null, deadline_at = null, state_changed_at = p_at, version = version + 1
      where identity_id = i.identity_id;
    perform {{schema}}.enqueue_event('identity.closed', null, 'identity', i.identity_id, i.version + 1, null, p_correlation, p_at,
      jsonb_build_object('identityId', i.identity_id, 'personalGroupId', i.personal_group_id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- The recovery hold (recovery process, rule 3) -------------------------------

alter table {{schema}}.identity add column credentials_recovered_at timestamptz;
alter table {{schema}}.pending_change add column held_until timestamptz;

-- Authentication reported a credential recovery; the host relays it.
create function {{schema}}.record_credential_recovery(p_identity uuid, p_recovered_at timestamptz)
returns boolean language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  update {{schema}}.identity set credentials_recovered_at = greatest(coalesce(credentials_recovered_at, p_recovered_at), p_recovered_at)
    where identity_id = p_identity and kind = 'person' and state <> 'closed';
  return found;
end $$;

-- A critical change requested within the hold is held until it ends. The
-- hold is the policy's, never under 24 hours, whatever the caller sets.
create function {{schema}}.recovery_hold() returns trigger language plpgsql as $$
declare
  v_recovered timestamptz;
  v_hours integer := greatest(coalesce(nullif(current_setting('identity.recovery_hold_hours', true), '')::integer, 72), 24);
begin
  if new.risk <> 'critical' then return new; end if;
  select i.credentials_recovered_at into v_recovered from {{schema}}.identity i where i.identity_id = new.requester_id;
  if v_recovered is not null and v_recovered + make_interval(hours => v_hours) > new.created_at then
    new.held_until := v_recovered + make_interval(hours => v_hours);
    if new.route = 'published-delay' then new.delay_ends_at := greatest(new.delay_ends_at, new.held_until); end if;
  end if;
  return new;
end $$;

create trigger pending_change_hold before insert on {{schema}}.pending_change for each row execute function {{schema}}.recovery_hold();

create function {{schema}}.announce_hold() returns trigger language plpgsql as $$
begin
  perform {{schema}}.enqueue_event('approval.held', new.requester_id, 'approval', new.change_id, new.version, new.tenant_id, new.correlation_id, new.created_at,
    jsonb_build_object('changeId', new.change_id, 'groupId', new.group_id, 'heldUntil', {{schema}}.iso(new.held_until)));
  return new;
end $$;

create trigger pending_change_hold_announced after insert on {{schema}}.pending_change
  for each row when (new.held_until is not null) execute function {{schema}}.announce_hold();

-- Orphaned-group recovery -----------------------------------------------------

alter table {{schema}}.pending_change drop constraint pending_change_route_check;
alter table {{schema}}.pending_change add constraint pending_change_route_check
  check (route in ('approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'platform-operator', 'none'));
-- A held change waits as delayed whatever its route.
alter table {{schema}}.pending_change drop constraint pending_change_check1;
alter table {{schema}}.pending_change add constraint pending_change_delay_check
  check ((route <> 'published-delay' or delay_ends_at is not null) and (state <> 'delayed' or delay_ends_at is not null));
alter table {{schema}}.pending_change drop constraint pending_change_check2;
alter table {{schema}}.pending_change add constraint pending_change_expiry_check
  check ((route in ('approvers', 'parent-owner', 'tenant-owner', 'platform-operator')) = (expires_at is not null));

-- The group's longest-standing active member: the only one a member may propose.
create function {{schema}}.longest_member(p_group uuid, p_at timestamptz) returns uuid language sql stable as $$
  select m.identity_id from {{schema}}.membership m join {{schema}}.identity i on i.identity_id = m.identity_id
  where m.group_id = p_group and m.state = 'active' and m.kind = 'member' and i.kind = 'person' and i.state = 'active'
    and m.starts_at <= p_at and (m.ends_at is null or m.ends_at > p_at)
  order by m.starts_at, m.created_at, m.membership_id limit 1
$$;

create function {{schema}}.is_member_in_effect(p_identity uuid, p_group uuid, p_at timestamptz) returns boolean language sql stable as $$
  select exists (select 1 from {{schema}}.membership m join {{schema}}.identity i on i.identity_id = m.identity_id
    where m.identity_id = p_identity and m.group_id = p_group and m.state = 'active' and i.state = 'active'
      and m.starts_at <= p_at and (m.ends_at is null or m.ends_at > p_at))
$$;

-- Records a proposed owner for an orphaned group, checking the recovery
-- rules: an owner above proposes any active member but themselves; a member
-- may propose only where no owner exists above, only the longest-standing
-- member (themselves included), and only through the published delay.
create function {{schema}}.record_recovery(p jsonb) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  c {{schema}}.pending_change%rowtype;
  m {{schema}}.membership%rowtype;
  g {{schema}}."group"%rowtype;
  v_at timestamptz := (p ->> 'at')::timestamptz;
  v_lineage uuid[];
  v_parent uuid;
  v_root uuid;
  v_requester uuid := (p ->> 'requesterId')::uuid;
  v_above boolean;
begin
  select * into m from {{schema}}.membership where membership_id = (p ->> 'membershipId')::uuid;
  if not found then raise exception 'identity:unknown'; end if;
  select * into g from {{schema}}."group" where group_id = m.group_id and kind = 'standard';
  if not found then raise exception 'identity:unknown'; end if;
  if not {{schema}}.is_active_person(v_requester) then raise exception 'identity:unknown'; end if;
  v_lineage := {{schema}}.lineage_of(g.group_id);
  if cardinality(v_lineage) > 1 then
    v_parent := v_lineage[cardinality(v_lineage) - 1];
    v_root := v_lineage[1];
  end if;
  v_above := v_parent is not null and ({{schema}}.owns(v_requester, v_parent) or {{schema}}.owns(v_requester, v_root));
  if not v_above and not {{schema}}.is_member_in_effect(v_requester, g.group_id, v_at) then raise exception 'identity:unknown'; end if;
  if g.state <> 'orphaned' then raise exception 'identity:group-not-orphaned'; end if;
  if m.state <> 'active' or m.kind <> 'member' or not {{schema}}.is_member_in_effect(m.identity_id, g.group_id, v_at)
    or not {{schema}}.is_active_person(m.identity_id) then
    raise exception 'identity:not-eligible';
  end if;
  c.route := p ->> 'route';
  c.delay_ends_at := (p ->> 'delayEndsAt')::timestamptz;
  c.expires_at := (p ->> 'expiresAt')::timestamptz;
  if v_above then
    if m.identity_id = v_requester then raise exception 'identity:self-grant'; end if;
    if c.route not in ('parent-owner', 'tenant-owner', 'published-delay') then raise exception 'identity:approval-floor'; end if;
  else
    if v_parent is not null and {{schema}}.active_owner_count(v_parent, '{}') + {{schema}}.active_owner_count(v_root, '{}') > 0 then
      raise exception 'identity:recovery-by-owners';
    end if;
    if m.identity_id is distinct from {{schema}}.longest_member(g.group_id, v_at) then raise exception 'identity:not-longest-member'; end if;
    if c.route <> 'published-delay' then raise exception 'identity:approval-floor'; end if;
  end if;
  if c.route = 'published-delay' and (c.delay_ends_at is null or c.delay_ends_at < v_at + interval '7 days') then raise exception 'identity:approval-floor'; end if;
  if c.route <> 'published-delay' and (c.expires_at is null or c.expires_at <= v_at or c.expires_at > v_at + interval '14 days') then
    raise exception 'identity:approval-floor';
  end if;
  if p ->> 'reasonCode' is null then raise exception 'identity:justification-missing'; end if;
  c.change_id := {{schema}}.uuid_v7();
  c.type := 'group.appoint-owner';
  c.tenant_id := g.tenant_id;
  c.group_id := g.group_id;
  c.requester_id := v_requester;
  c.beneficiary_id := m.identity_id;
  c.risk := 'critical';
  c.reason_code := p ->> 'reasonCode';
  c.reference := p ->> 'reference';
  c.target := jsonb_build_object('membershipId', m.membership_id);
  c.created_id := null;
  c.internal := '{}'::jsonb;
  c.required_approvals := 1;
  c.approvals := '[]'::jsonb;
  if c.route <> 'published-delay' then c.delay_ends_at := null; else c.expires_at := null; end if;
  c.state := case when c.route = 'published-delay' then 'delayed' else 'awaiting-approval' end;
  c.correlation_id := (p ->> 'correlationId')::uuid;
  c.created_at := v_at;
  c.version := 1;
  c.change_digest := {{schema}}.digest_of(c);
  insert into {{schema}}.pending_change select c.*;
  select * into c from {{schema}}.pending_change where change_id = c.change_id;
  perform {{schema}}.enqueue_event('approval.requested', v_requester, 'approval', c.change_id, 1, c.tenant_id, c.correlation_id, v_at,
    jsonb_build_object('changeId', c.change_id, 'changeType', c.type, 'groupId', c.group_id, 'risk', c.risk, 'route', c.route,
      'requiredApprovals', c.required_approvals, 'delayEndsAt', {{schema}}.iso(c.delay_ends_at)));
  return {{schema}}.change_json(c);
end $$;

-- A member of the orphaned group objects during the delay: automatic
-- appointment stops and a platform operator decides.
create function {{schema}}.object_to_recovery(p_change uuid, p_member uuid, p_assurance jsonb, p_expires timestamptz, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare c {{schema}}.pending_change%rowtype; v_version integer;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  if not found or c.type <> 'group.appoint-owner' or not {{schema}}.is_member_in_effect(p_member, c.group_id, p_at) then raise exception 'identity:unknown'; end if;
  if c.state <> 'delayed' or c.route <> 'published-delay' then raise exception 'identity:not-pending'; end if;
  if p_member = c.requester_id then raise exception 'identity:approval-refused'; end if;
  if p_expires <= p_at or p_expires > p_at + interval '14 days' then raise exception 'identity:approval-floor'; end if;
  update {{schema}}.pending_change set
    approvals = approvals || jsonb_build_array(jsonb_build_object('approverId', p_member, 'decision', 'object', 'decidedAt', {{schema}}.iso(p_at),
      'assurance', p_assurance, 'changeDigest', c.change_digest)),
    route = 'platform-operator', state = 'awaiting-approval', delay_ends_at = null, expires_at = p_expires
    where change_id = p_change returning * into c;
  update {{schema}}.pending_change set change_digest = {{schema}}.digest_of(c) where change_id = p_change returning * into c;
  perform {{schema}}.enqueue_event('approval.requested', p_member, 'approval', c.change_id, c.version, c.tenant_id, p_correlation, p_at,
    jsonb_build_object('changeId', c.change_id, 'changeType', c.type, 'groupId', c.group_id, 'risk', c.risk, 'route', c.route,
      'requiredApprovals', c.required_approvals, 'delayEndsAt', null));
  return {{schema}}.change_json(c);
end $$;

create function {{schema}}.appoint_owner(p_membership uuid, p_at timestamptz) returns void language plpgsql as $$
declare m {{schema}}.membership%rowtype; g {{schema}}."group"%rowtype; v_version integer;
begin
  select * into m from {{schema}}.membership where membership_id = p_membership for update;
  if not found then raise exception 'identity:unknown'; end if;
  select * into g from {{schema}}."group" where group_id = m.group_id and kind = 'standard' for update;
  if not found then raise exception 'identity:unknown'; end if;
  if g.state <> 'orphaned' then raise exception 'identity:group-not-orphaned'; end if;
  if m.kind <> 'member' or m.owner or not {{schema}}.is_member_in_effect(m.identity_id, g.group_id, p_at) or not {{schema}}.is_active_person(m.identity_id) then
    raise exception 'identity:not-eligible';
  end if;
  update {{schema}}.membership set owner = true where membership_id = p_membership;
  update {{schema}}."group" set version = version where group_id = g.group_id returning version into v_version;
  perform {{schema}}.enqueue_event('group.owners-changed', {{schema}}.context_uuid('identity.actor_id'), 'group', g.group_id, v_version, g.tenant_id,
    {{schema}}.context_uuid('identity.correlation_id'), p_at,
    jsonb_build_object('groupId', g.group_id, 'added', jsonb_build_array(m.identity_id), 'removed', '[]'::jsonb,
      'changeId', {{schema}}.context_uuid('identity.change_id'), 'breakGlassReviewId', {{schema}}.context_uuid('identity.break_glass_review_id')));
end $$;

-- Applies a recovery, and holds any critical change still under a recovery hold.
create or replace function {{schema}}.settle_change(p_change uuid, p_at timestamptz, p_actor uuid) returns text language plpgsql as $$
declare c {{schema}}.pending_change%rowtype; v_outcome text; v_version integer;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  if c.held_until is not null and c.held_until > p_at then
    update {{schema}}.pending_change set state = 'delayed', delay_ends_at = c.held_until where change_id = p_change;
    return 'held';
  end if;
  begin
    if c.type = 'group.appoint-owner' then
      if {{schema}}.digest_of(c) <> c.change_digest then raise exception 'identity:change-differs'; end if;
      perform {{schema}}.set_context(c.requester_id, c.correlation_id, p_at);
      perform set_config('identity.change_id', c.change_id::text, true);
      perform {{schema}}.appoint_owner((c.target ->> 'membershipId')::uuid, p_at);
      perform set_config('identity.change_id', '', true);
    else
      perform {{schema}}.apply_change(c, p_at);
    end if;
    update {{schema}}.pending_change set state = 'applied', decided_at = p_at where change_id = p_change returning version into v_version;
    v_outcome := 'applied';
  exception when others then
    update {{schema}}.pending_change set state = 'rejected', decided_at = p_at, failure = left(sqlerrm, 200) where change_id = p_change returning version into v_version;
    v_outcome := 'rejected';
  end;
  perform {{schema}}.enqueue_event('approval.decided', p_actor, 'approval', p_change, v_version, c.tenant_id, c.correlation_id, p_at,
    jsonb_build_object('changeId', p_change, 'outcome', v_outcome));
  return v_outcome;
end $$;

-- Break-glass (ADR-0007) --------------------------------------------------------
-- Reviews span tenants and are never granted: the runtime role reaches them
-- only through the functions below.

create table {{schema}}.break_glass_review (
  review_id uuid primary key,
  break_glass_identity_id uuid not null references {{schema}}.identity (identity_id),
  action text not null check (action in ('suspend-identity', 'suspend-membership', 'appoint-owner')),
  target_id uuid not null,
  tenant_id uuid references {{schema}}.tenant (tenant_id),
  reason_code text not null,
  correlation_id uuid not null,
  used_at timestamptz not null,
  state text not null check (state in ('open', 'closed')),
  closed_by uuid references {{schema}}.identity (identity_id),
  closed_at timestamptz,
  outcome text,
  version integer not null check (version >= 1),
  check (closed_by is null or closed_by <> break_glass_identity_id),
  check ((state = 'closed') = (closed_by is not null and closed_at is not null and outcome is not null))
);
create trigger break_glass_review_version before update on {{schema}}.break_glass_review for each row execute function {{schema}}.bump_version();

create function {{schema}}.break_glass_review_json(r {{schema}}.break_glass_review) returns jsonb language sql stable as $$
  select jsonb_build_object('reviewId', r.review_id, 'breakGlassIdentityId', r.break_glass_identity_id, 'action', r.action,
    'targetId', r.target_id, 'tenantId', r.tenant_id, 'reasonCode', r.reason_code, 'correlationId', r.correlation_id,
    'usedAt', {{schema}}.iso(r.used_at), 'state', r.state, 'closedBy', r.closed_by, 'closedAt', {{schema}}.iso(r.closed_at),
    'outcome', r.outcome, 'version', r.version)
$$;

-- One of exactly three actions, at once, by an active break-glass identity.
-- Opens a review and announces the use.
create function {{schema}}.break_glass_act(p_actor uuid, p_action text, p_target uuid, p_reason text, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  r {{schema}}.break_glass_review%rowtype;
  v_i {{schema}}.identity%rowtype;
  v_m {{schema}}.membership%rowtype;
  v_tenant uuid;
begin
  if not exists (select 1 from {{schema}}.identity i where i.identity_id = p_actor and i.kind = 'break-glass' and i.state = 'active') then
    raise exception 'identity:unknown';
  end if;
  if p_reason is null then raise exception 'identity:justification-missing'; end if;
  r.review_id := {{schema}}.uuid_v7();
  perform {{schema}}.set_context(p_actor, p_correlation, p_at);
  perform set_config('identity.break_glass_review_id', r.review_id::text, true);
  if p_action = 'suspend-identity' then
    select * into v_i from {{schema}}.identity where identity_id = p_target for update;
    if not found or v_i.kind not in ('person', 'service') then raise exception 'identity:unknown'; end if;
    if v_i.state not in ('active', 'paused') then raise exception 'identity:not-suspendable'; end if;
    update {{schema}}.identity set state = 'suspended', previous_state = v_i.state, state_changed_at = p_at, version = version + 1 where identity_id = p_target;
    perform {{schema}}.enqueue_event('identity.suspended', p_actor, 'identity', p_target, v_i.version + 1, null, p_correlation, p_at,
      jsonb_build_object('identityId', p_target, 'reasonCode', p_reason, 'changeId', null, 'breakGlassReviewId', r.review_id));
  elsif p_action in ('suspend-membership', 'appoint-owner') then
    select * into v_m from {{schema}}.membership where membership_id = p_target;
    if not found or not exists (select 1 from {{schema}}."group" g where g.group_id = v_m.group_id and g.kind = 'standard') then
      raise exception 'identity:unknown';
    end if;
    v_tenant := v_m.tenant_id;
    if p_action = 'suspend-membership' then
      if v_m.state not in ('active', 'paused') then raise exception 'identity:not-suspendable'; end if;
      update {{schema}}.membership set state = 'suspended', reason_code = p_reason where membership_id = p_target;
    else
      perform {{schema}}.appoint_owner(p_target, p_at);
    end if;
  else
    raise exception 'identity:unknown';
  end if;
  r.break_glass_identity_id := p_actor;
  r.action := p_action;
  r.target_id := p_target;
  r.tenant_id := v_tenant;
  r.reason_code := p_reason;
  r.correlation_id := p_correlation;
  r.used_at := p_at;
  r.state := 'open';
  r.version := 1;
  insert into {{schema}}.break_glass_review select r.*;
  perform {{schema}}.enqueue_event('break-glass.used', p_actor, 'break-glass-review', r.review_id, 1, v_tenant, p_correlation, p_at,
    jsonb_build_object('reviewId', r.review_id, 'breakGlassIdentityId', p_actor, 'action', p_action, 'targetId', p_target, 'reasonCode', p_reason));
  perform set_config('identity.break_glass_review_id', '', true);
  return {{schema}}.break_glass_review_json(r);
end $$;

-- Closed by another person, whom the layer has authorised.
create function {{schema}}.close_break_glass_review(p_review uuid, p_closer uuid, p_outcome text, p_correlation uuid, p_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare r {{schema}}.break_glass_review%rowtype;
begin
  select * into r from {{schema}}.break_glass_review where review_id = p_review for update;
  if not found or not {{schema}}.is_active_person(p_closer) then raise exception 'identity:unknown'; end if;
  if r.state <> 'open' then raise exception 'identity:not-pending'; end if;
  if r.break_glass_identity_id = p_closer then raise exception 'identity:approval-refused'; end if;
  update {{schema}}.break_glass_review set state = 'closed', closed_by = p_closer, closed_at = p_at, outcome = p_outcome
    where review_id = p_review returning * into r;
  perform {{schema}}.enqueue_event('break-glass.review-closed', p_closer, 'break-glass-review', r.review_id, r.version, r.tenant_id, p_correlation, p_at,
    jsonb_build_object('reviewId', r.review_id, 'closedBy', p_closer, 'outcome', p_outcome));
  return {{schema}}.break_glass_review_json(r);
end $$;

create function {{schema}}.get_break_glass_review(p_review uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select {{schema}}.break_glass_review_json(r) from {{schema}}.break_glass_review r where r.review_id = p_review
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
grant execute on function
  {{schema}}.last_owner_of(uuid),
  {{schema}}.pause_identity(uuid, uuid, timestamptz),
  {{schema}}.resume_identity(uuid, uuid, timestamptz),
  {{schema}}.request_closure(uuid, timestamptz, boolean, uuid, timestamptz),
  {{schema}}.cancel_closure(uuid, uuid, timestamptz),
  {{schema}}.close_due_identities(uuid, timestamptz, integer),
  {{schema}}.record_credential_recovery(uuid, timestamptz),
  {{schema}}.record_recovery(jsonb),
  {{schema}}.object_to_recovery(uuid, uuid, jsonb, timestamptz, uuid, timestamptz),
  {{schema}}.break_glass_act(uuid, text, uuid, text, uuid, timestamptz),
  {{schema}}.close_break_glass_review(uuid, uuid, text, uuid, timestamptz),
  {{schema}}.get_break_glass_review(uuid)
to {{runtime}};
`,
  },
  {
    id: '0006_administration_reads',
    sql: `
-- Reads for the administration surface (SECURITY DEFINER; granted) ------------
-- Each returns exactly an answer the layer parses with the contract before
-- it leaves; the layer authorises the caller first.

create function {{schema}}.membership_json(m {{schema}}.membership) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'membershipId', m.membership_id, 'identityId', m.identity_id, 'groupId', m.group_id, 'tenantId', m.tenant_id,
    'kind', m.kind, 'state', m.state, 'owner', m.owner, 'foundingOwner', m.founding_owner,
    'startsAt', {{schema}}.iso(m.starts_at), 'endsAt', {{schema}}.iso(m.ends_at), 'endedAt', {{schema}}.iso(m.ended_at),
    'endReason', m.end_reason, 'reasonCode', m.reason_code, 'createdAt', {{schema}}.iso(m.created_at), 'version', m.version)
$$;

-- A page of a group's live memberships, with each identity's state for the effective status.
create function {{schema}}.group_members(p_group uuid, p_after uuid, p_limit integer)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('membership', {{schema}}.membership_json(page.m), 'identityState', page.identity_state) order by (page.m).membership_id), '[]'::jsonb)
  from (
    select m, i.state as identity_state
    from {{schema}}.membership m join {{schema}}.identity i on i.identity_id = m.identity_id
      join {{schema}}."group" g on g.group_id = m.group_id
    where m.group_id = p_group and g.kind = 'standard' and m.state <> 'ended' and (p_after is null or m.membership_id > p_after)
    order by m.membership_id limit least(p_limit, 200)
  ) page
$$;

-- Identity's part of a data-subject access request.
create function {{schema}}.export_identity(p_identity uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'identity', jsonb_build_object(
      'identityId', i.identity_id, 'kind', i.kind, 'state', i.state, 'previousState', i.previous_state, 'homeTenantId', i.home_tenant_id,
      'personalGroupId', i.personal_group_id, 'ownerGroupId', i.owner_group_id, 'createdAt', {{schema}}.iso(i.created_at),
      'stateChangedAt', {{schema}}.iso(i.state_changed_at), 'deadlineAt', {{schema}}.iso(i.deadline_at), 'version', i.version),
    'externalIds', coalesce((select jsonb_agg(jsonb_build_object('tenantId', x.tenant_id, 'identityId', x.identity_id, 'externalId', x.external_id)
      order by x.tenant_id) from {{schema}}.identity_external_id x where x.identity_id = i.identity_id), '[]'::jsonb),
    'memberships', coalesce((select jsonb_agg({{schema}}.membership_json(m) order by m.created_at, m.membership_id)
      from {{schema}}.membership m where m.identity_id = i.identity_id), '[]'::jsonb))
  from {{schema}}.identity i where i.identity_id = p_identity
$$;

-- The structural part of SCIM resources (improvement register item 5).
create function {{schema}}.scim_user(p_identity uuid, p_tenant uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('identityId', i.identity_id, 'state', i.state, 'createdAt', {{schema}}.iso(i.created_at),
    'lastModified', {{schema}}.iso(i.state_changed_at), 'version', i.version,
    'externalId', (select x.external_id from {{schema}}.identity_external_id x where x.identity_id = i.identity_id and x.tenant_id = p_tenant))
  from {{schema}}.identity i where i.identity_id = p_identity and i.kind <> 'break-glass' and i.state <> 'pending'
$$;

create function {{schema}}.scim_group(p_group uuid, p_at timestamptz)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('groupId', g.group_id, 'externalId', g.external_id, 'name', g.name, 'createdAt', {{schema}}.iso(g.created_at), 'version', g.version,
    'members', coalesce((select jsonb_agg(m.identity_id order by m.identity_id)
      from {{schema}}.membership m join {{schema}}.identity i on i.identity_id = m.identity_id
      where m.group_id = g.group_id and m.state in ('active', 'paused') and i.state in ('active', 'paused')
        and m.starts_at <= p_at and (m.ends_at is null or m.ends_at > p_at)), '[]'::jsonb))
  from {{schema}}."group" g where g.group_id = p_group and g.kind = 'standard'
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
grant execute on function
  {{schema}}.change_json({{schema}}.pending_change),
  {{schema}}.group_members(uuid, uuid, integer),
  {{schema}}.export_identity(uuid),
  {{schema}}.scim_user(uuid, uuid),
  {{schema}}.scim_group(uuid, timestamptz)
to {{runtime}};
`,
  },
  {
    id: '0007_safety_periods',
    sql: `
-- Safety periods (docs/contracts.md §21) --------------------------------------
-- Each standard group may set its own safety periods. The platform group's
-- are the platform's; a root group's apply to every group under it; a
-- group's to itself. The safest applies, within hard bounds. Only a
-- 'group.change-safety-periods' change, approved at critical risk, writes
-- them; the runtime role has no grant on the column.

create function {{schema}}.safety_rule(p_key text) returns jsonb language sql immutable as $$
  select '{
    "publishedDelayHighHours": {"min": 24, "max": 336, "longer": true, "hours": 1},
    "publishedDelayCriticalHours": {"min": 72, "max": 720, "longer": true, "hours": 1},
    "approvalExpiryDays": {"min": 1, "max": 14, "longer": false, "hours": 24},
    "orphanRecoveryDelayDays": {"min": 7, "max": 60, "longer": true, "hours": 24},
    "recoveryHoldHours": {"min": 24, "max": 336, "longer": true, "hours": 1},
    "closureGraceDays": {"min": 7, "max": 90, "longer": true, "hours": 24}
  }'::jsonb -> p_key
$$;

create function {{schema}}.safety_keys() returns text[] language sql immutable as $$
  select array['publishedDelayHighHours', 'publishedDelayCriticalHours', 'approvalExpiryDays', 'orphanRecoveryDelayDays', 'recoveryHoldHours', 'closureGraceDays']
$$;

-- Only known settings, as whole numbers within the hard bounds.
create function {{schema}}.safety_periods_valid(p jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where {{schema}}.safety_rule(e.key) is null or jsonb_typeof(e.value) <> 'number'
      or (e.value)::numeric <> trunc((e.value)::numeric)
      or (e.value)::numeric < ({{schema}}.safety_rule(e.key) ->> 'min')::numeric
      or (e.value)::numeric > ({{schema}}.safety_rule(e.key) ->> 'max')::numeric)
$$;

-- The safer of two values; a null defers to the other.
create function {{schema}}.safer(p_key text, a numeric, b numeric) returns numeric language sql immutable as $$
  select case when a is null then b when b is null then a
    when ({{schema}}.safety_rule(p_key) ->> 'longer')::boolean then greatest(a, b) else least(a, b) end
$$;

create function {{schema}}.less_safe(p_key text, p_next numeric, p_current numeric) returns boolean language sql immutable as $$
  select case when ({{schema}}.safety_rule(p_key) ->> 'longer')::boolean then p_next < p_current else p_next > p_current end
$$;

alter table {{schema}}."group" add column safety_periods jsonb not null default '{}'::jsonb;
alter table {{schema}}."group" add constraint group_safety_periods_valid
  check ({{schema}}.safety_periods_valid(safety_periods) and (kind = 'standard' or safety_periods = '{}'::jsonb));

-- The runtime role may create groups, but never with safety periods of their own.
create function {{schema}}.guard_group_safety_periods() returns trigger language plpgsql as $$
begin
  if not {{schema}}.is_owner_role() and new.safety_periods <> '{}'::jsonb then raise exception 'identity:requires-approval'; end if;
  return new;
end $$;

create trigger group_safety_periods_guard before insert on {{schema}}."group" for each row execute function {{schema}}.guard_group_safety_periods();

-- The platform's values: its own settings over the host's, over the least
-- safe hard bound when the host's are not known.
create function {{schema}}.platform_periods(p_own jsonb, p_host jsonb) returns jsonb language sql immutable as $$
  select jsonb_object_agg(k, coalesce(
    (p_own ->> k)::numeric,
    (p_host ->> k)::numeric,
    case when ({{schema}}.safety_rule(k) ->> 'longer')::boolean then ({{schema}}.safety_rule(k) ->> 'min')::numeric
      else ({{schema}}.safety_rule(k) ->> 'max')::numeric end))
  from unnest({{schema}}.safety_keys()) k
$$;

-- The periods in force for a group: the safest of the platform's, its root
-- group's and its own (p_own, when given, instead of what is stored). The
-- closure grace period is the platform's alone.
create function {{schema}}.effective_periods(p_group uuid, p_platform uuid, p_host jsonb, p_own jsonb) returns jsonb language plpgsql stable as $$
declare
  v_own jsonb;
  v_root jsonb;
  v_platform jsonb;
  v_lineage uuid[];
  v_result jsonb := '{}'::jsonb;
  k text;
  v numeric;
begin
  select coalesce(p_own, g.safety_periods) into v_own from {{schema}}."group" g where g.group_id = p_group;
  v_lineage := {{schema}}.lineage_of(p_group);
  if cardinality(v_lineage) > 1 then
    select g.safety_periods into v_root from {{schema}}."group" g where g.group_id = v_lineage[1];
  end if;
  if p_platform is not null and p_platform = p_group then
    v_platform := {{schema}}.platform_periods(v_own, p_host);
  elsif p_platform is not null then
    select {{schema}}.platform_periods(g.safety_periods, p_host) into v_platform from {{schema}}."group" g where g.group_id = p_platform and g.kind = 'standard';
  end if;
  v_platform := coalesce(v_platform, {{schema}}.platform_periods('{}'::jsonb, p_host));
  foreach k in array {{schema}}.safety_keys() loop
    v := (v_platform ->> k)::numeric;
    if k <> 'closureGraceDays' then
      v := {{schema}}.safer(k, v, (v_root ->> k)::numeric);
      v := {{schema}}.safer(k, v, (v_own ->> k)::numeric);
    end if;
    v_result := v_result || jsonb_build_object(k, v);
  end loop;
  return v_result;
end $$;

-- How long a change of periods waits once approved, in hours: the longer of
-- the current critical delay and each delay it shortens; zero if nothing
-- becomes less safe.
create function {{schema}}.wait_out_hours(p_current jsonb, p_next jsonb) returns numeric language sql immutable as $$
  select coalesce(max(greatest((p_current ->> 'publishedDelayCriticalHours')::numeric,
    case when ({{schema}}.safety_rule(k) ->> 'longer')::boolean
      then (p_current ->> k)::numeric * ({{schema}}.safety_rule(k) ->> 'hours')::numeric else 0 end)), 0)
  from unnest({{schema}}.safety_keys()) k
  where {{schema}}.less_safe(k, (p_next ->> k)::numeric, (p_current ->> k)::numeric)
$$;

-- The values a change of periods compares: the platform's for the platform
-- group, the group's in force otherwise.
create function {{schema}}.compared_periods(p_group uuid, p_platform uuid, p_host jsonb, p_own jsonb) returns jsonb language plpgsql stable as $$
begin
  if p_platform is not null and p_platform = p_group then
    return {{schema}}.platform_periods(coalesce(p_own, (select g.safety_periods from {{schema}}."group" g where g.group_id = p_group)), p_host);
  end if;
  return {{schema}}.effective_periods(p_group, p_platform, p_host, p_own);
end $$;

-- Every recorded change keeps the periods in force for its group: a delay
-- no shorter, an expiry no longer, the recovery hold no shorter. A change of
-- periods that makes any less safe is held until the old values have run.
-- The layer sets the platform group and the host's values for the
-- transaction; without them, the hard bounds stand in for the host's.
create function {{schema}}.enforce_safety_periods() returns trigger language plpgsql as $$
declare
  v_platform uuid := {{schema}}.context_uuid('identity.platform_group_id');
  v_host jsonb := nullif(current_setting('identity.host_periods', true), '')::jsonb;
  v_periods jsonb;
  v_need interval;
  v_recovered timestamptz;
  v_wait numeric;
begin
  v_periods := {{schema}}.effective_periods(new.group_id, v_platform, v_host, null);
  if new.route = 'published-delay' then
    v_need := case
      when new.type = 'group.appoint-owner' then make_interval(days => (v_periods ->> 'orphanRecoveryDelayDays')::integer)
      when new.risk = 'critical' then make_interval(hours => (v_periods ->> 'publishedDelayCriticalHours')::integer)
      else make_interval(hours => (v_periods ->> 'publishedDelayHighHours')::integer) end;
    if new.delay_ends_at < new.created_at + v_need then raise exception 'identity:approval-floor'; end if;
  end if;
  if new.expires_at is not null and new.expires_at > new.created_at + make_interval(days => (v_periods ->> 'approvalExpiryDays')::integer) then
    raise exception 'identity:approval-floor';
  end if;
  if new.risk = 'critical' then
    select i.credentials_recovered_at into v_recovered from {{schema}}.identity i where i.identity_id = new.requester_id;
    if v_recovered is not null and v_recovered + make_interval(hours => (v_periods ->> 'recoveryHoldHours')::integer) > new.created_at then
      new.held_until := greatest(new.held_until, v_recovered + make_interval(hours => (v_periods ->> 'recoveryHoldHours')::integer));
    end if;
  end if;
  if new.type = 'group.change-safety-periods' then
    if not {{schema}}.safety_periods_valid(new.target -> 'safetyPeriods') then raise exception 'identity:invalid-safety-periods'; end if;
    v_wait := {{schema}}.wait_out_hours(
      {{schema}}.compared_periods(new.group_id, v_platform, v_host, null),
      {{schema}}.compared_periods(new.group_id, v_platform, v_host, new.target -> 'safetyPeriods'));
    if v_wait > 0 then
      new.held_until := greatest(new.held_until, new.created_at + make_interval(hours => v_wait::integer));
    end if;
  end if;
  if new.route = 'published-delay' and new.held_until is not null then new.delay_ends_at := greatest(new.delay_ends_at, new.held_until); end if;
  return new;
end $$;

-- Fires after pending_change_hold (triggers fire in name order).
create trigger pending_change_periods before insert on {{schema}}.pending_change
  for each row execute function {{schema}}.enforce_safety_periods();

-- The declared risk of the new change.
create or replace function {{schema}}.declared_risk(p_type text) returns text language sql immutable as $$
  select case p_type
    when 'group.create-root' then 'high' when 'group.reparent' then 'critical' when 'group.archive' then 'high'
    when 'group.change-settings' then 'high' when 'group.change-approvals' then 'critical'
    when 'group.change-safety-periods' then 'critical'
    when 'group.add-owner' then 'critical' when 'group.remove-owner' then 'critical' when 'group.suspend-owner' then 'critical'
    when 'membership.reinstate' then 'medium' when 'membership.schedule' then 'medium'
    when 'identity.suspend' then 'high' when 'identity.reinstate' then 'high' when 'service-identity.create' then 'high'
  end
$$;

-- Applies a change of periods, checking every rule again: the group is
-- active and its periods unchanged since the request; outside the platform
-- group (as recorded with the change) nothing is less safe than the levels
-- above and the platform-only settings are absent.
create function {{schema}}.apply_safety_periods(c {{schema}}.pending_change, p_at timestamptz) returns void language plpgsql as $$
declare
  v_group {{schema}}."group"%rowtype;
  v_platform uuid := (c.internal ->> 'platformGroupId')::uuid;
  v_host jsonb := c.internal -> 'hostPeriods';
  v_next jsonb := c.target -> 'safetyPeriods';
  v_above jsonb;
  v_version integer;
  k text;
begin
  if {{schema}}.digest_of(c) <> c.change_digest then raise exception 'identity:change-differs'; end if;
  perform {{schema}}.set_context(c.requester_id, c.correlation_id, p_at);
  perform set_config('identity.change_id', c.change_id::text, true);
  select * into v_group from {{schema}}."group" where group_id = (c.target ->> 'groupId')::uuid and kind = 'standard' for update;
  if not found then raise exception 'identity:unknown'; end if;
  if v_group.state <> 'active' then raise exception 'identity:group-not-active'; end if;
  if v_group.safety_periods <> (c.internal -> 'basePeriods') then raise exception 'identity:changed-since-request'; end if;
  if not {{schema}}.safety_periods_valid(v_next) then raise exception 'identity:invalid-safety-periods'; end if;
  if v_platform is null or v_platform <> v_group.group_id then
    if v_next ? 'closureGraceDays' then raise exception 'identity:platform-only'; end if;
    v_above := {{schema}}.effective_periods(v_group.group_id, v_platform, v_host, '{}'::jsonb);
    for k in select jsonb_object_keys(v_next) loop
      if {{schema}}.less_safe(k, (v_next ->> k)::numeric, (v_above ->> k)::numeric) then raise exception 'identity:safety-period-floor'; end if;
    end loop;
  end if;
  update {{schema}}."group" set safety_periods = v_next where group_id = v_group.group_id returning version into v_version;
  perform {{schema}}.enqueue_event('group.settings-changed', c.requester_id, 'group', v_group.group_id, v_version, v_group.tenant_id, c.correlation_id, p_at,
    jsonb_build_object('groupId', v_group.group_id, 'changed', jsonb_build_array('safetyPeriods')));
  perform set_config('identity.change_id', '', true);
end $$;

create or replace function {{schema}}.settle_change(p_change uuid, p_at timestamptz, p_actor uuid) returns text language plpgsql as $$
declare c {{schema}}.pending_change%rowtype; v_outcome text; v_version integer;
begin
  select * into c from {{schema}}.pending_change where change_id = p_change for update;
  if c.held_until is not null and c.held_until > p_at then
    update {{schema}}.pending_change set state = 'delayed', delay_ends_at = c.held_until where change_id = p_change;
    return 'held';
  end if;
  begin
    if c.type = 'group.appoint-owner' then
      if {{schema}}.digest_of(c) <> c.change_digest then raise exception 'identity:change-differs'; end if;
      perform {{schema}}.set_context(c.requester_id, c.correlation_id, p_at);
      perform set_config('identity.change_id', c.change_id::text, true);
      perform {{schema}}.appoint_owner((c.target ->> 'membershipId')::uuid, p_at);
      perform set_config('identity.change_id', '', true);
    elsif c.type = 'group.change-safety-periods' then
      perform {{schema}}.apply_safety_periods(c, p_at);
    else
      perform {{schema}}.apply_change(c, p_at);
    end if;
    update {{schema}}.pending_change set state = 'applied', decided_at = p_at where change_id = p_change returning version into v_version;
    v_outcome := 'applied';
  exception when others then
    update {{schema}}.pending_change set state = 'rejected', decided_at = p_at, failure = left(sqlerrm, 200) where change_id = p_change returning version into v_version;
    v_outcome := 'rejected';
  end;
  perform {{schema}}.enqueue_event('approval.decided', p_actor, 'approval', p_change, v_version, c.tenant_id, c.correlation_id, p_at,
    jsonb_build_object('changeId', p_change, 'outcome', v_outcome));
  return v_outcome;
end $$;

-- For the layer: a standard group's own periods, its root group's (null for
-- a root) and the platform group's (null without one). Numbers only.
create function {{schema}}.safety_periods_of(p_group uuid, p_platform uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'own', g.safety_periods,
    'root', (select r.safety_periods from {{schema}}."group" r
      where cardinality({{schema}}.lineage_of(g.group_id)) > 1 and r.group_id = ({{schema}}.lineage_of(g.group_id))[1]),
    'platform', (select p.safety_periods from {{schema}}."group" p where p.group_id = p_platform and p.kind = 'standard'),
    'isPlatformGroup', (g.group_id = p_platform) is true)
  from {{schema}}."group" g where g.group_id = p_group and g.kind = 'standard'
$$;

-- Privileges ----------------------------------------------------------------

revoke all on all functions in schema {{schema}} from public;
-- The column's check runs as whoever writes the row.
grant execute on function {{schema}}.safety_periods_of(uuid, uuid), {{schema}}.safety_periods_valid(jsonb), {{schema}}.safety_rule(text) to {{runtime}};
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
