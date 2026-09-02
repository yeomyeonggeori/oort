#!/usr/bin/env bash
# RED stub for SH-3a / #1955. The dispatcher sources this file.
# GREEN replaces the body with the real checks. Do not `exit` at parse time.

oort_doctor() {
  printf 'oort doctor RED stub: checks not implemented\n' >&2
  return 2
}
