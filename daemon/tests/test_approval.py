from oversight.approval import classify, inside_step_ids, point_in_polygon

SQUARE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
# A "C" shape: concave, open to the right between y=0.4 and y=0.6.
C_SHAPE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.4], [0.4, 0.4], [0.4, 0.6], [0.9, 0.6],
           [0.9, 0.9], [0.1, 0.9]]


def test_square_inside_outside():
    assert point_in_polygon(0.5, 0.5, SQUARE)
    assert not point_in_polygon(0.95, 0.5, SQUARE)
    assert not point_in_polygon(0.5, 0.05, SQUARE)


def test_concave_notch_is_outside():
    assert point_in_polygon(0.2, 0.5, C_SHAPE)        # spine of the C
    assert not point_in_polygon(0.7, 0.5, C_SHAPE)    # inside the notch
    assert point_in_polygon(0.7, 0.2, C_SHAPE)        # lower arm
    assert point_in_polygon(0.7, 0.8, C_SHAPE)        # upper arm


def test_empty_and_degenerate_polygons():
    assert not point_in_polygon(0.5, 0.5, [])
    assert not point_in_polygon(0.5, 0.5, [[0.1, 0.1]])
    assert not point_in_polygon(0.5, 0.5, [[0.1, 0.1], [0.9, 0.9]])


def test_point_on_vertex_row_counts_once():
    # The ray at y=0.5 passes exactly through the vertex (0.9, 0.5) of this diamond.
    diamond = [[0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5]]
    assert point_in_polygon(0.5, 0.5, diamond)
    assert not point_in_polygon(0.95, 0.5, diamond)
    assert not point_in_polygon(0.05, 0.5, diamond)
    # Horizontal edge on the ray's row: half-open rule keeps it consistent.
    assert point_in_polygon(0.5, 0.1 + 1e-9, SQUARE)


def test_classify_union_checked_minus_removed():
    pos = {
        "a": {"x": 0.5, "y": 0.5},   # inside polygon
        "b": {"x": 0.95, "y": 0.5},  # outside, checked
        "c": {"x": 0.95, "y": 0.95}, # outside, unchecked
        "d": {"x": 0.5, "y": 0.5},   # inside but removed
    }
    b = [{"x_dim": "x", "y_dim": "y", "polygon": SQUARE}]
    st = classify(["a", "b", "c", "d"], pos, checked=["b"], removed=["d"], boundaries=b)
    assert st == {"a": "approved", "b": "approved", "c": "pending", "d": "removed"}


def test_union_over_axis_pairs():
    pos = {"a": {"x": 0.5, "y": 0.5, "z": 0.05}, "b": {"x": 0.05, "y": 0.05, "z": 0.5}}
    bounds = [{"x_dim": "x", "y_dim": "y", "polygon": SQUARE},
              {"x_dim": "z", "y_dim": "y", "polygon": [[0.4, 0.0], [0.6, 0.0], [0.5, 0.2]]}]
    st = classify(["a", "b"], pos, [], [], bounds)
    assert st == {"a": "approved", "b": "approved"}
    # Removed beats both.
    assert classify(["a"], pos, ["a"], ["a"], bounds) == {"a": "removed"}
    # An empty stored polygon approves nothing.
    assert classify(["a"], pos, [], [], [{"x_dim": "x", "y_dim": "y", "polygon": []}]) == {
        "a": "pending"}


def test_inside_step_ids():
    pos = {"a": {"x": 0.5, "y": 0.5}, "b": {"x": 0.95, "y": 0.5}}
    assert inside_step_ids(pos, "x", "y", SQUARE) == ["a"]
    assert inside_step_ids(pos, "x", "y", []) == []
