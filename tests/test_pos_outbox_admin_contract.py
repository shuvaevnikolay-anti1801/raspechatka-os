from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pos_sync_can_pause_outbox_without_stopping_master_data_refresh():
    source = (ROOT / "pos/src/main/sync.ts").read_text(encoding="utf-8")
    assert "outbox_paused" in source
    assert "await applyBootstrap()" in source
    assert "pushEvents(config,events)" in source


def test_admin_can_inspect_pause_and_discard_pending_outbox_events():
    source = (ROOT / "pos/src/main/outbox-admin-ipc.ts").read_text(encoding="utf-8")
    assert "pos:list-outbox-events" in source
    assert "pos:get-outbox-paused" in source
    assert "pos:set-outbox-paused" in source
    assert "pos:discard-outbox-events" in source
    assert "verifyAdminCode" in source
    assert "markEventsSent" in source
    assert "currentShift()" in source


def test_settings_exposes_protected_outbox_management_ui():
    source = (ROOT / "pos/src/renderer/src/SettingsHub.tsx").read_text(encoding="utf-8")
    assert "Очередь синхронизации" in source
    assert "Приостановить отправку" in source
    assert "Удалить выбранные" in source
    assert "Удаление из очереди" in source
