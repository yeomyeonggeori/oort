"""Hermes directory plugin entrypoint for the momo platform adapter."""

from .momo_adapter import MomoAdapter, MomoConfig, register, register_platform

__all__ = ["MomoAdapter", "MomoConfig", "register", "register_platform"]
