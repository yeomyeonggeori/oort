#ifndef CMOMOPTY_H
#define CMOMOPTY_H

// POSIX pseudo-terminal calls that Swift's Glibc overlay does not surface (they
// require _XOPEN_SOURCE, which the Glibc modulemap does not set). Thin wrappers
// let MomoACPHost open a PTY on Linux for ACP terminal/* support in the work
// host sidecar. On Darwin openpty() is used directly and these go unused.
// (MOMO-579 / WH-1, ADR-0114 증보1 — Linux container portability)

int momo_posix_openpt(int flags);
int momo_grantpt(int fd);
int momo_unlockpt(int fd);
const char *momo_ptsname(int fd);

#endif /* CMOMOPTY_H */
