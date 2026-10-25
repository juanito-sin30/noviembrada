-- Cambiar la contraseña de un jugador (solo quien administra, desde el SQL Editor de Supabase
-- o con: npx supabase db query --linked -f supabase/admin/reset_password.sql).
-- Cambia 'marta.puig' (el nombre en minúsculas, sin acentos y con puntos) y la contraseña nueva.
update auth.users
   set encrypted_password = extensions.crypt('NUEVA_CONTRASEÑA', extensions.gen_salt('bf'))
 where email = 'marta.puig@noviembrada.local';
