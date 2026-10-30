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
print("PROBE " + json.dumps({
    "uid": os.getuid(), "home": os.environ["HERMES_HOME"], "plugin": listing,
    "refused_is_block": isinstance(refused, str) and "[oort-image-guard]" in refused, "accepted_is_none": accepted is None,
}, sort_keys=True))
