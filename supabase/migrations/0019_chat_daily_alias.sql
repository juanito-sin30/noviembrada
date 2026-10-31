-- El alias del chat cambia cada día (día de Europe/Madrid): descubrir quién es quién solo sirve para ese día.
alter table public.chat_aliases add column day date;
update public.chat_aliases set day = (public.app_now() at time zone 'Europe/Madrid')::date;
alter table public.chat_aliases alter column day set not null;
alter table public.chat_aliases drop constraint chat_aliases_pkey, drop constraint chat_aliases_edition_alias_key;
alter table public.chat_aliases add primary key (day, player_id), add unique (day, alias);

create or replace function public.chat_alias_of(p_player uuid, p_edition int) returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare a text; n int := 0; d date := (public.app_now() at time zone 'Europe/Madrid')::date;
  names text[] := array['Zorro','Cuervo','Lobo','Búho','Gato','Tejón','Halcón','Ciervo','Lince','Oso','Cisne','Jabalí','Nutria','Buitre','Lechuza','Mapache','Garza','Cabra','Erizo','Tigre','Pantera','Águila','Foca','Mirlo'];
begin
  select alias into a from public.chat_aliases where day = d and player_id = p_player;
  if found then return a; end if;
  loop
    a := names[1 + floor(random() * array_length(names, 1))::int] || ' ' || (1 + floor(random() * 99))::int;
    begin
      insert into public.chat_aliases (edition, day, player_id, alias) values (p_edition, d, p_player, a);
      return a;
    exception when unique_violation then
      select alias into a from public.chat_aliases where day = d and player_id = p_player;
      if found then return a; end if;
      n := n + 1; if n > 200 then raise exception 'alias_exhausted'; end if;
    end;
  end loop;
end
$$;
revoke execute on function public.chat_alias_of(uuid, int) from public, anon, authenticated;
