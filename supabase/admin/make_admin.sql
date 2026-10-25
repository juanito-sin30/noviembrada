-- Dar permisos de administración (sorteo y herramientas de prueba) a un jugador ya registrado.
update public.players set is_admin = true where name_key = 'marta.puig';
