#!/usr/bin/env python3
"""Runs inside the LIVE Hermes gateway container as the `hermes` user (scripts/tests/test_hermes_image_guard_docker.sh, #4820
review). Stdlib plus the image's own Hermes modules. It loads plugins from the real volume (HERMES_HOME=/opt/data), exactly
where the running gateway got them, and asks the same hook dispatcher the agent loop uses about two image_generate calls.
Prints one line: PROBE {json}. No tool runs, no network."""
import json
import os
import sys

sys.path.insert(0, "/opt/hermes")
os.environ.setdefault("HERMES_HOME", "/opt/data")
from hermes_cli.plugins import _dispatch_pre_tool_call_hooks, discover_plugins, get_plugin_manager  # noqa: E402

discover_plugins()
listing = [{k: p.get(k) for k in ("name", "source", "enabled", "hooks", "error")}
           for p in get_plugin_manager().list_plugins() if p.get("name") == "oort-image-guard"]
refused = _dispatch_pre_tool_call_hooks("image_generate", {"prompt": "x", "image_url": "https://canary.invalid/x"},
                                        tool_call_id="live-1", turn_id="live-1")[0]
accepted = _dispatch_pre_tool_call_hooks("image_generate", {"prompt": "x"}, tool_call_id="live-2", turn_id="live-2")[0]
# The owner's 10-30 exception: with OORT_SELF_MEDIA_ORIGIN in the container's environment the one allowed address passes
# and a bypass variant of it is blocked, asked of the same dispatcher.
origin = os.environ.get("OORT_SELF_MEDIA_ORIGIN", "")
tail = "0000000a-0000-4000-8000-00000000000b/" + "C" * 43
self_address = origin + "/v1/self-media/" + tail
self_ok = _dispatch_pre_tool_call_hooks("image_generate", {"prompt": "x", "image_url": self_address},
                                        tool_call_id="live-3", turn_id="live-3")[0]
self_variant = _dispatch_pre_tool_call_hooks("image_generate", {"prompt": "x", "image_url": self_address + "?q=1"},
                                             tool_call_id="live-4", turn_id="live-4")[0]
self_reference = _dispatch_pre_tool_call_hooks("image_generate", {"prompt": "x", "reference_image_urls": [self_address]},
                                               tool_call_id="live-5", turn_id="live-5")[0]
print("PROBE " + json.dumps({
    "uid": os.getuid(), "home": os.environ["HERMES_HOME"], "plugin": listing,
    "refused_is_block": isinstance(refused, str) and "[oort-image-guard]" in refused, "accepted_is_none": accepted is None,
    "origin_set": bool(origin), "self_address_is_none": self_ok is None,
    "self_variant_is_block": isinstance(self_variant, str) and "[oort-image-guard]" in self_variant,
    "self_as_reference_is_block": isinstance(self_reference, str) and "[oort-image-guard]" in self_reference,
}, sort_keys=True))
