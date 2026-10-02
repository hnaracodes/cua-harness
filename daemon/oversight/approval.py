"""The approval rule from the docs/01 sprint contract addendum.

A step is `removed` if removed. Otherwise it is `approved` if it is checked OR its
RAW point lies inside ANY stored polygon (one per axis pair). Otherwise `pending`.
The inside test is the even-odd ray cast, written exactly as in the UI.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

Point = Sequence[float]


def point_in_polygon(x: float, y: float, polygon: Sequence[Point]) -> bool:
    """Even-odd ray cast. For each edge (i, j = i - 1):
    if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi): flip."""
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = float(polygon[i][0]), float(polygon[i][1])
        xj, yj = float(polygon[j][0]), float(polygon[j][1])
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def step_point(positions: Mapping[str, float], x_dim: str, y_dim: str) -> tuple[float, float]:
    """RAW grid point for an axis pair. Display jitter is never used here."""
    return positions[x_dim], positions[y_dim]


def inside_any(positions: Mapping[str, float], boundaries: Iterable[Mapping]) -> bool:
    for b in boundaries:
        poly = b.get("polygon") or []
        if len(poly) < 3:
            continue
        x, y = step_point(positions, b["x_dim"], b["y_dim"])
        if point_in_polygon(x, y, poly):
            return True
    return False


def classify(
    step_ids: Iterable[str],
    positions_by_step: Mapping[str, Mapping[str, float]],
    checked: Iterable[str],
    removed: Iterable[str],
    boundaries: Iterable[Mapping],
) -> dict[str, str]:
    """step_id -> 'approved' | 'pending' | 'removed'."""
    checked_s, removed_s = set(checked), set(removed)
    bounds = list(boundaries)
    out: dict[str, str] = {}
    for sid in step_ids:
        if sid in removed_s:
            out[sid] = "removed"
        elif sid in checked_s or inside_any(positions_by_step.get(sid, {}), bounds):
            out[sid] = "approved"
        else:
            out[sid] = "pending"
    return out


def approved_set(statuses: Mapping[str, str]) -> set[str]:
    return {sid for sid, st in statuses.items() if st == "approved"}


def inside_step_ids(positions_by_step: Mapping[str, Mapping[str, float]], x_dim: str,
                    y_dim: str, polygon: Sequence[Point]) -> list[str]:
    return [sid for sid, pos in positions_by_step.items()
            if len(polygon) >= 3 and point_in_polygon(*step_point(pos, x_dim, y_dim), polygon)]
