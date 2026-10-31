#!/usr/bin/env python3
"""ADR-0218 storage samples on an already-running API; stdlib, no Docker control.

Bearer is read from the gate's registered private curl config, never argv or
retained samples. The caller owns login, fixtures, lifecycle and shape checking.
"""
import argparse
import json
import re
import struct
import uuid
import zlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base-url", "workspace", "channel", "auth-config", "out-dir", "manifest"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    config = Path(args.auth_config).read_text()
    match = re.fullmatch(r'header = "Authorization: Bearer ([^"\r\n]+)"\n?', config)
    if not match:
        raise SystemExit("expression sampler: invalid private credential config")
    bearer = match[1]
    base = args.base_url.rstrip("/")
    prefix = f"/v1/workspaces/{args.workspace}"
    template = "/v1/workspaces/{ws}"
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    samples = []

    def request(method, path, body=None, content_type="application/json", auth=True, expected=200):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        headers = {"Content-Type": content_type}
        if auth:
            headers["Authorization"] = "Bearer " + bearer
        url = urljoin(base + "/", path)
        if urlsplit(url).netloc != urlsplit(base).netloc:
            raise SystemExit("expression sampler: upload must remain on fixture API origin")
        try:
            response = urlopen(Request(url, data=data, headers=headers, method=method), timeout=15)
        except HTTPError as error:
            response = error
        raw = response.read()
        if response.status != expected:
            raise SystemExit(f"expression sampler: {method} {urlsplit(path).path} expected {expected}, got {response.status}")
        mime = response.headers.get_content_type()
        return (json.loads(raw) if mime == "application/json" else raw), mime

    def record(method, path, status, value, mime="application/json"):
        file = out / f"expression-{len(samples):02d}.{'json' if mime == 'application/json' else 'bin'}"
        file.write_bytes(json.dumps(value, ensure_ascii=False).encode() if mime == "application/json" else value)
        samples.append({"name": f"expression-{len(samples)}", "method": method.lower(),
                        "path": template + path, "status": str(status),
                        "media_type": mime, "body_file": str(file)})

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")
    name = "gate_" + uuid.uuid4().hex[:20]
    metadata = {"name": name, "displayName": "contract image", "tags": [], "subjectMemberId": None}
    boundary = "oort-expression-contract"

    def multipart(metadata=None):
        b = b""
        if metadata is not None:
            b += (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n' + json.dumps(metadata) + "\r\n").encode()
        return b + f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + png + f"\r\n--{boundary}--\r\n".encode()

    value, mime = request("GET", prefix + "/expressions")
    record("GET", "/expressions", 200, value, mime)
    draft, _ = request("POST", prefix + "/expressions/uploads", multipart(metadata),
                       f"multipart/form-data; boundary={boundary}", expected=201)
    record("POST", "/expressions/uploads", 201, draft)
    draft_path = f"/expression-drafts/{draft['draftId']}"
    value, _ = request("GET", prefix + draft_path)
    record("GET", "/expression-drafts/{draftId}", 200, value)
    image, mime = request("GET", prefix + draft_path + "/image?size=large&v=" + draft["media"]["large"]["sha256"])
    record("GET", "/expression-drafts/{draftId}/image", 200, image, mime)
    draft, _ = request("PUT", prefix + draft_path + "/file", multipart(), f"multipart/form-data; boundary={boundary}")
    record("PUT", "/expression-drafts/{draftId}/file", 200, draft)
    choice = {"draftId": draft["draftId"], "revision": draft["revision"], "sha256": draft["media"]["large"]["sha256"]}
    value, _ = request("POST", prefix + "/expressions", choice, expected=201)
    record("POST", "/expressions", 201, value)
    expression_path = "/expressions/" + value["expression"]["id"]
    image, mime = request("GET", prefix + expression_path + "/image?size=large&v=" + choice["sha256"])
    record("GET", "/expressions/{id}/image", 200, image, mime)
    value, _ = request("PATCH", prefix + expression_path, {"displayName": "contract edited"})
    record("PATCH", "/expressions/{id}", 200, value)

    # Real completed, self-uploaded attachment in the caller's live channel.
    channel_path = prefix + "/channels/" + args.channel
    upload, _ = request("POST", channel_path + "/attachments/uploads", {"name": "expression.png", "mime": "image/png", "size": len(png)}, expected=201)
    request("PUT", upload["uploadUrl"], png, "image/png", auth=False)
    request("POST", channel_path + "/attachments/" + upload["id"] + "/complete", {})
    request("POST", channel_path + "/messages", {"clientMsgId": str(uuid.uuid4()), "body": "expression attachment", "attachmentIds": [upload["id"]]}, expected=201)
    attachment_metadata = dict(metadata, name="file_" + uuid.uuid4().hex[:20], attachmentId=upload["id"], channelId=args.channel)
    value, _ = request("POST", prefix + "/expressions/from-attachment", attachment_metadata, expected=201)
    record("POST", "/expressions/from-attachment", 201, value)
    # Link import (#4829). The gate has no outbound network to fetch a picture from, so it
    # samples the contract's other branch on the real route: `.invalid` never resolves
    # (RFC 6761), so the live answer is 200 + a manual_upload_required card carrying
    # source_unavailable (or source_timeout if the gate's DNS hangs past the 5 s deadline).
    import_request = dict(metadata, name="link_" + uuid.uuid4().hex[:20],
                          url="https://expression-import.invalid/gate.gif?token=gate")
    value, _ = request("POST", prefix + "/expressions/import", import_request, expected=200)
    if value.get("state") != "manual_upload_required" or value.get("code") not in ("source_unavailable", "source_timeout"):
        raise SystemExit("expression sampler: import of an unresolvable link must be a manual card")
    if "token=gate" in json.dumps(value):
        raise SystemExit("expression sampler: the link's query reached the response")
    record("POST", "/expressions/import", 200, value)
    # Photo route (#4941, ADR-0218 section 8 H9). The gate has no image model to call, so it samples
    # the two answers a deployment without one gives on the real routes: the availability read says
    # no model is connected, and a well-formed photo request is told so with the closed 409 code
    # (nothing is sent anywhere, nothing is stored).
    value, _ = request("GET", prefix + "/expressions/photo-model")
    if value.get("available") is not False or value.get("provider") is not None:
        raise SystemExit("expression sampler: the gate deployment must have no image model connected")
    record("GET", "/expressions/photo-model", 200, value)
    photo_metadata = {"branch": "cutout", "acknowledgedProvider": "openai", "name": "photo_" + uuid.uuid4().hex[:20],
                      "displayName": "contract photo", "tags": [], "subjectMemberId": None}
    value, _ = request("POST", prefix + "/expressions/photo-drafts", multipart(photo_metadata),
                       f"multipart/form-data; boundary={boundary}", expected=409)
    if value.get("error", {}).get("code") != "image_model_unavailable":
        raise SystemExit("expression sampler: a photo request without an image model must be image_model_unavailable")
    record("POST", "/expressions/photo-drafts", 409, value)
    value, _ = request("POST", prefix + expression_path + "/report", {"reason": "other"})
    record("POST", "/expressions/{id}/report", 200, value)
    value, _ = request("DELETE", prefix + expression_path)
    record("DELETE", "/expressions/{id}", 200, value)
    with Path(args.manifest).open("a") as manifest:
        for sample in samples:
            manifest.write(json.dumps(sample) + "\n")
    print(f"expression sampler: {len(samples)} live storage operations passed")


if __name__ == "__main__":
    main()
