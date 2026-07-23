from src.cli import collect_log_files


def test_collect_log_files_from_bag_root(tmp_path):
    """A bag root should yield only the text logs, not binary siblings."""
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "planner_stdout.txt").write_text("x")
    (tmp_path / "logs" / "execution_manager_stdout.log").write_text("x")
    (tmp_path / "traces").mkdir()
    (tmp_path / "traces" / "trace_30.pbbin").write_bytes(b"\x00")
    (tmp_path / "mcap").mkdir()
    (tmp_path / "mcap" / "data.mcap").write_bytes(b"\x00")
    (tmp_path / "drive_info.yaml").write_text("x")
    (tmp_path / "recorder_manager_config.txtpb").write_text("x")

    found = [p.name for p in collect_log_files(tmp_path)]
    assert found == ["execution_manager_stdout.log", "planner_stdout.txt"]


def test_collect_log_files_flat_dir(tmp_path):
    (tmp_path / "a.txt").write_text("x")
    (tmp_path / "b.log").write_text("x")
    found = [p.name for p in collect_log_files(tmp_path)]
    assert found == ["a.txt", "b.log"]
