"""oort prime adapter — `prime-agent --mode rpc` relayed into an oort channel."""

from .oort_client import OortClient, OortError, stable_key
from .prime_adapter import AdapterSettings, PrimeAdapter
from .refine import HarnessObserver, RefineAnnouncer
from .rpc import JsonlRpc
from .stream_relay import StreamRelay

__all__ = [
    "AdapterSettings",
    "HarnessObserver",
    "JsonlRpc",
    "OortClient",
    "OortError",
    "PrimeAdapter",
    "RefineAnnouncer",
    "StreamRelay",
    "stable_key",
]
