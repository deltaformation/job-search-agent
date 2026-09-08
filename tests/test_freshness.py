from datetime import datetime, timezone, timedelta
from services.discovery.freshness import calculate_freshness

def test_freshness_hot():
    # 5 hours ago
    posted = datetime.now(timezone.utc) - timedelta(hours=5)
    age_hours, bucket = calculate_freshness(posted)
    assert 4.5 <= age_hours <= 5.5
    assert bucket == "HOT"

def test_freshness_fresh():
    # 30 hours ago
    posted = datetime.now(timezone.utc) - timedelta(hours=30)
    age_hours, bucket = calculate_freshness(posted)
    assert 29.5 <= age_hours <= 30.5
    assert bucket == "FRESH"

def test_freshness_recent():
    # 60 hours ago
    posted = datetime.now(timezone.utc) - timedelta(hours=60)
    age_hours, bucket = calculate_freshness(posted)
    assert 59.5 <= age_hours <= 60.5
    assert bucket == "RECENT"

def test_freshness_stale():
    # 80 hours ago
    posted = datetime.now(timezone.utc) - timedelta(hours=80)
    age_hours, bucket = calculate_freshness(posted)
    assert age_hours > 72.0
    assert bucket == "STALE"
