from oversight.store import Store


def _store(tmp_path):
    return Store(tmp_path / "t.db")


def _plan():
    steps = [{"id": f"stp_{i}", "index": i, "title": f"T{i}", "description": "d",
              "glyph": "generic"} for i in (1, 2)]
    scores = [{"step_id": f"stp_{i}", "dimension": "reversibility", "label": "x",
               "position": 0.1 * i, "confidence": 0.5, "rationale": "r"} for i in (1, 2)]
    return steps, scores


def test_attachment_dedupe_and_link(tmp_path):
    s = _store(tmp_path)
    a = s.add_attachment("abc", "image/png", 10, "/x/a.png")
    assert s.add_attachment("abc", "image/png", 10, "/x/a.png") == a
    c = s.add_attachment("def", "image/jpeg", 20, "/x/c.jpg")
    tid = s.create_task("p", None, "live")
    s.link_attachments(tid, [c, a])
    got = s.get_task_attachments(tid)
    assert [g["attachment_id"] for g in got] == [c, a]
    assert (got[0]["mime"], got[0]["bytes"], got[0]["path"]) == ("image/jpeg", 20, "/x/c.jpg")
    assert s.get_attachment(a)["sha256"] == "abc"
    assert s.get_attachment("att_missing") is None


def test_settings_roundtrip(tmp_path):
    s = _store(tmp_path)
    assert s.get_setting("plan_only", False) is False
    s.set_setting("plan_only", True)
    s.set_setting("key_tested", {"anthropic": True})
    s.set_setting("plan_only", True)  # upsert, not a duplicate row
    assert s.get_setting("plan_only") is True
    assert s.get_setting("key_tested") == {"anthropic": True}


def test_frames_seq_is_per_task(tmp_path):
    s = _store(tmp_path)
    t1 = s.create_task("a", None, "live")
    t2 = s.create_task("b", None, "live")
    assert s.add_frame(t1, "run_1", "stp_1", "/f/1.jpg") == 1
    assert s.add_frame(t1, "run_1", "stp_1", "/f/2.jpg") == 2
    assert s.add_frame(t2, "run_2", "stp_9", "/f/3.jpg") == 1
    assert s.get_frame(t1, 2)["path"] == "/f/2.jpg"
    assert s.get_frame(t1, 3) is None


def test_revise_plan_keeps_boundaries_replace_plan_drops_them(tmp_path):
    s = _store(tmp_path)
    tid = s.create_task("p", None, "live")
    steps, scores = _plan()
    s.replace_plan(tid, steps, scores)
    s.put_boundary(tid, "action_uncertainty", "reversibility", [[0, 0], [1, 0], [1, 1]])
    s.revise_plan(tid, steps[:1], scores[:1])
    assert [x["id"] for x in s.get_steps(tid)] == ["stp_1"]
    assert [x["step_id"] for x in s.get_scores(tid)] == ["stp_1"]
    assert len(s.get_boundaries(tid)) == 1
    s.replace_plan(tid, steps, scores)
    assert s.get_boundaries(tid) == []


def test_update_step_keeps_first_edited_from_and_replaces_scores(tmp_path):
    s = _store(tmp_path)
    tid = s.create_task("p", None, "live")
    steps, scores = _plan()
    s.replace_plan(tid, steps, scores)
    s.update_step("stp_1", "New", "nd", "T1")
    s.update_step("stp_1", "Newer", "nd2", "New")
    st1 = s.get_steps(tid)[0]
    assert (st1["title"], st1["description"], st1["edited_from"]) == ("Newer", "nd2", "T1")
    assert st1["revision"] == 2
    s.replace_step_scores("stp_1", [{"step_id": "stp_1", "dimension": "verifiability",
                                     "label": "y", "position": 0.7, "confidence": 0.9,
                                     "rationale": "q"}])
    mine = [x for x in s.get_scores(tid) if x["step_id"] == "stp_1"]
    assert [m["dimension"] for m in mine] == ["verifiability"]
