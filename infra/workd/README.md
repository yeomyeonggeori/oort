# momo-workd v0 service assets

`momo-workd` is an outbound-only user service. It opens no listener and polls the
oort REST API for controls addressed to its registered Ed25519 identity. Tool
stdout/stderr is written under `~/.local/share/momo/workd-output/` with mode
`0600`; it is not sent to the oort server.

After registration, workd reads the enabled workspace `work_tool_profile`
projection with its signed host identity. The server provides only a portable
command key and arguments. Executable paths and optional
`MOMO_WORKD_PROFILE_<TOOL_KEY>_{EXECUTABLE,ARGUMENTS_JSON}` overrides remain in
the host's private environment; credentials are never catalog fields.

Tool children receive an allowlisted environment by default: `PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `COLORTERM`, and `TMPDIR`.
Add host-owned keys explicitly with comma-separated
`MOMO_WORKD_ENV_PASSTHROUGH`. A profile `envPolicy.passthrough` narrows those
host-approved key names for that tool; it cannot widen the host list. During
migration only, the old broad inheritance can be enabled
globally with `MOMO_WORKD_CHILD_ENV_MODE=legacy`, or per profile by setting
`envPolicy.mode=legacy` and host-side `MOMO_WORKD_ALLOW_PROFILE_LEGACY_ENV=1`.
`MOMO_WORKD_*` control values are never passed to tool children in any mode.

The checked-in launchd and systemd files are templates consumed by
`bootstrap.sh`. The bootstrap expects a binary compiled for the target OS and
architecture, an HTTPS oort server, workspace UUID, and a one-time human access
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
