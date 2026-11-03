-- Lista de todas las fotos y vídeos, en orden cronológico, con el nombre nuevo que tendrán al exportarlos.
-- Solo para quien administra, y solo al acabar la Noviembrada. El lugar es privado: no sale en la app, pero aquí sí.
select
  to_char(row_number() over (order by t.touched_at, m.id), 'FM000') || '_' ||
    to_char(t.touched_at at time zone 'Europe/Madrid', 'YYYY-MM-DD_HH24-MI') || '_' ||
    regexp_replace(coalesce(pf.name, 'Sorteo'), '[^A-Za-z0-9]+', '', 'g') || '-a-' ||
    regexp_replace(pt.name, '[^A-Za-z0-9]+', '', 'g') ||
    case when m.path ~* '\.quicktime$' then '.mov' else coalesce(substring(m.path from '\.[A-Za-z0-9]+$'), case when m.kind = 'video' then '.mp4' else '.jpg' end) end as nuevo_nombre,
  m.path as ruta_original,
  m.kind as tipo,
  t.edition as edicion,
  to_char(t.touched_at at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as fecha_madrid,
  coalesce(pf.name, 'Sorteo') as quien_pillo,
  pt.name as a_quien,
  t.place as lugar,
  t.status as estado
from public.touch_media m
join public.touches t on t.id = m.touch_id
left join public.players pf on pf.id = t.from_id
join public.players pt on pt.id = t.to_id
where t.status <> 'void'
order by t.touched_at, m.id;
