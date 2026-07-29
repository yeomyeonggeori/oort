#!/usr/bin/env python3
"""TLS termination in front of the momo-workd attach listener (MOMO-674).

`momo-workd` listens in PLAINTEXT and publishes a `wss://` endpoint, because a
self-hosted deployment already has a proxy holding its certificate
(docs/runbooks/workd-terminal-attach.md). Every assertion about attach is
therefore an assertion about the deployed shape only if the verifier dials
through such a proxy, so this is the smallest honest stand-in for one.

It is a BYTE RELAY, not an HTTP proxy: after the TLS handshake it copies both
directions verbatim and never parses a request line, a header or a frame. That
is deliberate and is what makes the subprotocol claim structural rather than
promised — `Sec-WebSocket-Protocol: momo.terminal.v1, <capability>` cannot be
rewritten, reordered or dropped by something that never reads it. The daemon
sees exactly the bytes the client wrote.

Test scaffolding only. The certificate is generated per run by the caller and
the private key never leaves the run's 0700 temp directory.
"""

from __future__ import annotations

import argparse
import os
import selectors
import socket
import ssl
import sys
import threading

BUFFER_BYTES = 64 * 1024


def log(message: str) -> None:
    print(f"[attach-proxy] {message}", file=sys.stderr, flush=True)


def relay(client: ssl.SSLSocket, upstream: socket.socket) -> None:
    """Copy in both directions until either side is done with the other."""
    selector = selectors.DefaultSelector()
    selector.register(client, selectors.EVENT_READ, upstream)
    selector.register(upstream, selectors.EVENT_READ, client)
    try:
        while True:
            for key, _ in selector.select(timeout=1.0):
                source = key.fileobj
                target = key.data
                try:
                    chunk = source.recv(BUFFER_BYTES)
                except (ssl.SSLWantReadError, BlockingIOError):
                    continue
                except OSError:
                    return
                if not chunk:
                    # One direction closed. Pass the FIN on so the peer sees the
                    # daemon's close rather than an anonymous reset, then stop.
                    try:
                        target.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    return
                try:
                    target.sendall(chunk)
                except OSError:
                    return
    finally:
        selector.close()


def serve_connection(
    raw: socket.socket, context: ssl.SSLContext, target_port: int
) -> None:
    upstream = None
    try:
        client = context.wrap_socket(raw, server_side=True)
    except (ssl.SSLError, OSError) as error:
        log(f"tls handshake failed: {error}")
        raw.close()
        return
    try:
        upstream = socket.create_connection(("127.0.0.1", target_port), timeout=10)
        upstream.settimeout(None)
        relay(client, upstream)
    except OSError as error:
        log(f"upstream {target_port} unreachable: {error}")
    finally:
        for sock in (client, upstream):
            if sock is None:
                continue
            try:
                sock.close()
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-port", type=int, required=True)
    parser.add_argument("--target-port", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument(
        "--ready-file",
        help="Created once the listening socket is bound, so a caller can wait "
        "on a fact instead of on a sleep.",
    )
    args = parser.parse_args()

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=args.cert, keyfile=args.key)

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.listen_port))
    listener.listen(16)
    log(f"wss 127.0.0.1:{args.listen_port} -> tcp 127.0.0.1:{args.target_port}")
    if args.ready_file:
        with open(args.ready_file, "w", encoding="utf-8") as handle:
            handle.write("ready\n")
        os.chmod(args.ready_file, 0o600)

    try:
        while True:
            raw, _ = listener.accept()
            raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            thread = threading.Thread(
                target=serve_connection,
                args=(raw, context, args.target_port),
                daemon=True,
            )
            thread.start()
    except KeyboardInterrupt:
        return 0
    finally:
        listener.close()


if __name__ == "__main__":
    sys.exit(main())
