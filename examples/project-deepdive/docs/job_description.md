# Staff Engineer, Data Platform

Vector Foundry is hiring a Staff Engineer to lead the next generation of our event-ingestion platform.

Responsibilities:

- Own the architecture for our streaming ingestion tier — currently 4M events/sec at peak, projected to 12M within 18 months.
- Design tiered storage layouts that balance cost (cold storage, deduplication) against query latency for the analytics product.
- Lead capacity-planning and cutover decisions on dual-write migrations between storage backends.
- Mentor a team of 5 senior engineers; own the technical roadmap for the platform.

Must-have:

- Demonstrated track record running large streaming pipelines in production (millions of events per second).
- Experience designing dual-write / shadow-traffic migrations where the cutover gate was a non-trivial decision.
- Distributed-systems fluency: consistency models, backpressure, idempotency, queue topology.
- Comfort owning an online migration end-to-end (design → cutover → validation).

Nice-to-have:

- Open-source maintenance experience — code-review judgment for external contributions.
- Postgres / Iceberg / Glacier exposure.
