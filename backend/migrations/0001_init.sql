-- 0001_init: base schema.
-- Application tables live in `app`, not `public`, so Supabase's auto-generated Data API
-- never exposes them. Tables arrive in later migrations (users and sessions in task 2).

create schema if not exists app;

comment on schema app is 'Job Application Tracker application tables';
