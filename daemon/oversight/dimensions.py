"""Loads dimensions.yaml, the single source of truth for the ten dimensions.

Both GET /dimensions and the scorer prompt read from here, so the axis tooltip
the user sees is the exact string the scorer was given.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

DIMENSIONS_PATH = Path(__file__).with_name("dimensions.yaml")

#: The within-label offset is clamped to this range so a position never sits
#: on a band edge, where it could be read as the neighbouring label.
WITHIN_MIN = 0.05
WITHIN_MAX = 0.95


@dataclass(frozen=True)
class Dimension:
    key: str
    name: str
    definition: str
    labels: tuple[str, ...]
    anchors: tuple[float, ...]
    label_descriptions: dict[str, str]

    def band(self, label: str) -> tuple[float, float]:
        i = self.labels.index(label)
        n = len(self.labels)
        return i / n, (i + 1) / n

    def position(self, label: str, within: float) -> float:
        """Position derived from the label band: label i of N owns [i/N, (i+1)/N]
        and `within` (0 = low-risk edge, 1 = high-risk edge) places the point
        inside it. A position can never land in a different band from its label."""
        lo, hi = self.band(label)
        w = min(WITHIN_MAX, max(WITHIN_MIN, float(within)))
        return round(lo + (hi - lo) * w, 4)

    def to_api(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "definition": self.definition,
            "labels": list(self.labels),
            "anchors": list(self.anchors),
            "label_descriptions": dict(self.label_descriptions),
        }


@lru_cache(maxsize=1)
def load_dimensions() -> tuple[Dimension, ...]:
    raw = yaml.safe_load(DIMENSIONS_PATH.read_text())
    dims = []
    for d in raw["dimensions"]:
        labels = tuple(str(x) for x in d["labels"])
        n = len(labels)
        anchors = tuple(float(a) for a in d["anchors"])
        expected = tuple(round((i + 0.5) / n, 6) for i in range(n))
        if tuple(round(a, 6) for a in anchors) != expected:
            raise ValueError(f"{d['key']}: anchors must be band centres {expected}")
        descs = {str(k): str(v) for k, v in d["label_descriptions"].items()}
        if set(descs) != set(labels):
            raise ValueError(f"{d['key']}: label_descriptions must cover exactly the labels")
        dims.append(
            Dimension(
                key=d["key"],
                name=d["name"],
                definition=d["definition"],
                labels=labels,
                anchors=anchors,
                label_descriptions=descs,
            )
        )
    if len(dims) != 10:
        raise ValueError(f"expected exactly ten dimensions, found {len(dims)}")
    return tuple(dims)


def dimension_map() -> dict[str, Dimension]:
    return {d.key: d for d in load_dimensions()}


DIMENSION_KEYS: tuple[str, ...] = tuple(d.key for d in load_dimensions())
