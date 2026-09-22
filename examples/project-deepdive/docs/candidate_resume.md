# Priya Raman

Senior Software Engineer with 8 years of experience building distributed systems, low-latency data pipelines, and developer-facing platforms.

Experience:

## Staff Engineer, Skyline Telemetry — 2023 to present
- Tech lead for the **session-replay ingestion pipeline** rewrite (Project Helix).
  - Replaced a Kafka + Redis fan-out with a custom WebSocket gateway and a tiered storage layout (hot Redis, warm S3-with-Iceberg, cold Glacier).
  - Cut p99 ingest latency from 2.4s to 280ms across 12B sessions/day.
  - Owned the cutover plan: 6-week shadow-traffic period, dual-write window, automated divergence checks.
  - Team of 4 engineers; Priya owned design, scaling, and the cutover gate decision.
- Co-led the move from per-tenant single-writer Postgres to per-tenant logical sharding via Citus.

## Senior Engineer, Lumen Logistics — 2020 to 2023
- Built the **driver dispatch optimizer** (Project Atlas) — graph-based route planning serving 11k drivers across 3 metros.
  - Replaced a daily batch (Spark) job with an online streaming graph mutator.
  - Owned the algorithm: A*-on-time-graph with custom heuristics derived from historical traffic patterns.
  - Reduced planning latency from 4 hours to under 90 seconds; reduced empty miles by 8%.
- On-call for the dispatch service for 18 months; handled the 2022 Memorial Day outage (postmortem published internally).

## Software Engineer, Patchwork Health — 2017 to 2020
- Built ETL pipelines for clinic billing reconciliation.
- HIPAA compliance work; SOC 2 Type II audit owner for two cycles.

Education: BS Computer Science, UCLA (2017).

Selected open-source contributions:
- Maintainer of `pg-fastdump` (Postgres parallel dump tool, 1.8k stars).
- Contributor to `streamline-rs` graph library.
