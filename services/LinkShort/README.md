# LinkShort

LinkShort is the standalone ADR-0121 S-4 v0 invite redirector: set the required `MOMO_LINKSHORT_TARGET_BASE_URL` to the momo web origin, optionally set `MOMO_LINKSHORT_PORT` (default `28190`), and point the chosen invite-link domain's DNS/reverse proxy at this service; `GET /i/{code}` redirects to that origin's `/join/{code}` without validating or looking up the code, while a multi-tenant code-to-server mapping registry remains a follow-up after the domain is decided.
