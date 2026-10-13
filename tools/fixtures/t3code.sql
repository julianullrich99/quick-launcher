-- A tiny T3 Code state database for tools/shoot.sh: only the tables and
-- columns the launcher reads. Times are relative to now.
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_runs (
  run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, requested_at TEXT NOT NULL);

INSERT INTO projection_projects VALUES
  ('p1', 'quick-launcher'), ('p2', 'shop-api'), ('p3', 'website');

INSERT INTO orchestration_v2_projection_threads VALUES
  ('t1', 'p1', 'T3 Code sessions in the launcher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 seconds'), NULL, NULL,
   '{"branch":"feat/t3code","settledOverride":null,"lineage":{"parentThreadId":null}}'),
  ('t2', 'p2', 'Fix checkout rounding', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 seconds'), NULL, NULL,
   '{"branch":"fix/rounding","settledOverride":null,"lineage":{"parentThreadId":null}}'),
  ('t3', 'p3', 'Landing page copy review', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes'), NULL, NULL,
   '{"branch":"main","settledOverride":null,"lineage":{"parentThreadId":null}}'),
  ('t4', 'p2', 'Migrate orders to Postgres 17', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), NULL, NULL,
   '{"branch":"chore/pg17","settledOverride":null,"lineage":{"parentThreadId":null}}'),
  ('t5', 'p1', 'Release v2.0.0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), NULL, NULL,
   '{"branch":"main","settledOverride":"settled","lineage":{"parentThreadId":null}}'),
  ('t6', 'p1', 'Subagent: review', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'), NULL, NULL,
   '{"branch":null,"settledOverride":null,"lineage":{"parentThreadId":"t1"}}');

INSERT INTO orchestration_v2_projection_runs VALUES
  ('r1', 't1', 3, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-754 seconds')),
  ('r2', 't2', 1, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-95 seconds')),
  ('r3', 't3', 2, 'waiting', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 minutes')),
  ('r4', 't4', 1, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'));
