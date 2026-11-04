// Same-root representative production/restart proof; no business SQL seeding.
process.env.TEAM_ACCEPTANCE_PRODUCTION = '1';
await import('./team-acceptance-http.playwright.test.mjs');
