-- Bucket privado de pruebas (fotos y vídeos). Rutas: <touch_id>/<uid>/<archivo>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 41943040, array['image/*', 'video/*'])
on conflict (id) do update set public = false, file_size_limit = 41943040, allowed_mime_types = array['image/*', 'video/*'];

create policy proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs' and public.can_upload_media(name));
create policy proofs_select on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.can_view_media(name));
