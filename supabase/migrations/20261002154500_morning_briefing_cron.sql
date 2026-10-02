select cron.schedule(
  'dispatch-briefings-every-minute',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
        || '/functions/v1/dispatch-briefings',
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
