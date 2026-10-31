/** Original, synthetic test media; decode base64 in a host adapter. No network. */
export const FIXTURE_MEDIA = {
  gif: { bodyBase64: "R0lGODlhAQABAIAAAP+zAACg/yH/C05FVFNDQVBFMi4wAwEDAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==", image: { mime: "image/gif", sha256: "d7a0c3f3f3aa053922fdb5ee072f716a59ef300aa233d90419c3d1d9af960e2b", bytes: 85, width: 1, height: 1, frameCount: 2, durationMs: 200 } },
  png: { bodyBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4v5nhPwAHGQKyb+i68wAAAABJRU5ErkJggg==", image: { mime: "image/png", sha256: "72e69ee68c094c87f46e3a07ce29bf8c5a2ba0fa5ee7c7e191bfaa62a0440f27", bytes: 70, width: 1, height: 1, frameCount: 1, durationMs: 0 } },
} as const;
