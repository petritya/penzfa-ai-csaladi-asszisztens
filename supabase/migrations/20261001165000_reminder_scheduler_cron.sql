create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'dispatch-reminders-every-minute',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
        || '/functions/v1/dispatch-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_anon_key'),
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_anon_key')
      ),
      body := jsonb_build_object('source', 'cron'),
      timeout_milliseconds := 10000
    );
  $cron$
);

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'dispatch-reminders-every-minute'),
  active := false
);
