# Monitoring (feature 16)

Status: **metrics implemented and tested; Prometheus and Grafana configured but never started** (Docker is not installed on the development machine). Decisions: `docs/decisions.md` MON-1 to MON-4.

## Endpoints

| Where | How | Notes |
|---|---|---|
| API | `GET /metrics` on the API port | 404 unless `METRICS_TOKEN` (16+ characters) is set; otherwise `Authorization: Bearer <token>` or 401 |
| Worker | `GET /metrics` on `WORKER_METRICS_PORT` (0 = not served) | same token |
| Health | `GET /api/health` (alive), `GET /api/health/ready` (database reachable) | no token |

## What is measured

| Metric | Process | Meaning |
|---|---|---|
| `http_requests_total{method,route,status}` | API | requests; `route` is the address with ids and codes replaced by `:id`, or `unmatched` |
| `http_request_duration_seconds` (histogram) | API | request time |
| `jobs{status}` | both (from the database) | queued, running, succeeded, failed; **failed needs an administrator** (Admin > Jobs) |
| `jobs_oldest_due_age_seconds` | both | how long the oldest due job has waited; grows when the worker is stopped |
| `job_runs_total{type,outcome}`, `job_duration_seconds` | worker | succeeded, retried, failed runs by job type |
| `events_auto_closed_total` | worker | events closed automatically |
| `db_pool_connections{state}`, `database_up` | both | pool use; 0 when the metrics queries failed |
| `process_uptime_seconds`, `process_resident_memory_bytes` | both | |

## Running Prometheus and Grafana (not yet tried)

1. `npm run setup:env` (new `.env`) creates `METRICS_TOKEN` and `infra/monitoring/metrics-token`. With an existing `.env`, add `METRICS_TOKEN=<random 16+ characters>` and write the same value to `infra/monitoring/metrics-token` (gitignored).
2. `docker compose --profile app --profile monitoring up --build`
3. Prometheus http://localhost:9090 (Status > Targets: `api` and `worker` should be up; Alerts shows the rules). Grafana http://localhost:3000, user `admin`, password `GRAFANA_ADMIN_PASSWORD` (default `admin`: change it), dashboard "College Events".

Alert rules (`infra/monitoring/alerts.yml`): failed jobs, a job waiting more than 5 minutes, 5xx share above 5%, database down, a scrape target down. No alert receiver (email, chat) is configured: they show in Prometheus only.

## Logs

Structured JSON with a request id (`X-Request-Id`) on every API line and a job id on every job line. Secrets and request bodies are not logged.
