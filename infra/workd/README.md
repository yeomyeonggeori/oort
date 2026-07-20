# momo-workd v0 service assets

`momo-workd` is an outbound-only user service. It opens no listener and polls the
momo REST API for controls addressed to its registered Ed25519 identity. Tool
stdout/stderr is written under `~/.local/share/momo/workd-output/` with mode
`0600`; it is not sent to the momo server.

The checked-in launchd and systemd files are templates consumed by
`bootstrap.sh`. The bootstrap expects a binary compiled for the target OS and
architecture, an HTTPS momo server, workspace UUID, and a one-time human access
token supplied by private file or environment. The token becomes a remote
mode-`0600` file and is deleted only after registration succeeds and the host ID
has been saved locally.

```sh
chmod 600 /path/to/registration.token
scripts/momo host add ssh://user@host \
  --binary /path/to/target/momo-workd \
  --server-url https://momo.example.com \
  --workspace 00000000-0000-7000-8000-000000000001 \
  --token-file /path/to/registration.token
```

The SSH path is intentionally a v0 draft. Target binary distribution/signing,
cross-compilation, remote tool login bridges, automatic upgrades, and full PTY
support remain follow-up work.
