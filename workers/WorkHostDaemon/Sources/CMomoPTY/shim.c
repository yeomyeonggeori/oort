// _XOPEN_SOURCE must be defined before including <stdlib.h> so glibc declares
// the POSIX PTY functions. Compiles on both Linux and Darwin (both provide these
// in <stdlib.h>); only the Linux path actually calls them.
#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 600
#endif
#include <stdlib.h>
#include "cmomopty.h"

int momo_posix_openpt(int flags) { return posix_openpt(flags); }
int momo_grantpt(int fd) { return grantpt(fd); }
int momo_unlockpt(int fd) { return unlockpt(fd); }
const char *momo_ptsname(int fd) { return ptsname(fd); }
