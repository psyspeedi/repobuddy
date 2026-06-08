from dataclasses import dataclass
import time


@dataclass
class TelemetryEvent:
    name: str
    payload: dict
    timestamp: float


def log_event(name: str, payload: dict) -> None:
    event = TelemetryEvent(name=name, payload=payload, timestamp=time.time())
    _ = event  # would emit to a sink in a real system
