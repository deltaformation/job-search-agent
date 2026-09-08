from datetime import datetime, timezone, date
from typing import Optional, Union

def calculate_freshness(
    posted_at: Optional[Union[datetime, date, str]],
    observed_at: Optional[datetime] = None
) -> tuple[float, str]:
    """
    Computes age_hours and freshness_bucket.
    Buckets:
      HOT: 0 - 24 hours
      FRESH: 24 - 48 hours
      RECENT: 48 - 72 hours
      STALE: > 72 hours
    """
    now = datetime.now(timezone.utc)
    target_dt = None

    if posted_at is not None:
        if isinstance(posted_at, datetime):
            target_dt = posted_at if posted_at.tzinfo else posted_at.replace(tzinfo=timezone.utc)
        elif isinstance(posted_at, date):
            target_dt = datetime(posted_at.year, posted_at.month, posted_at.day, tzinfo=timezone.utc)
        elif isinstance(posted_at, str):
            try:
                # Attempt ISO or YYYY-MM-DD parse
                parsed = datetime.fromisoformat(posted_at.replace("Z", "+00:00"))
                target_dt = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            except Exception:
                pass

    if target_dt is None:
        if observed_at:
            target_dt = observed_at if observed_at.tzinfo else observed_at.replace(tzinfo=timezone.utc)
        else:
            target_dt = now

    diff_seconds = max(0.0, (now - target_dt).total_seconds())
    age_hours = round(diff_seconds / 3600.0, 1)

    if age_hours <= 24.0:
        bucket = "HOT"
    elif age_hours <= 48.0:
        bucket = "FRESH"
    elif age_hours <= 72.0:
        bucket = "RECENT"
    else:
        bucket = "STALE"

    return age_hours, bucket
