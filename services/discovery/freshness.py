from datetime import datetime, timezone, date, timedelta
from typing import Iterator, Optional, Union, NamedTuple

class FreshnessResult(NamedTuple):
    age_hours: float
    bucket: str
    is_observation_age: bool = False
    date_inconsistent: bool = False
    confidence: float = 1.0
    raw_age_hours: float = 0.0

    def __iter__(self) -> Iterator[Union[float, str]]:
        return iter((self.age_hours, self.bucket))

def calculate_freshness(
    posted_at: Optional[Union[datetime, date, str]],
    observed_at: Optional[datetime] = None,
    now: Optional[datetime] = None
) -> FreshnessResult:
    """
    Computes age_hours, freshness_bucket, observation provenance, and flags future/inconsistent dates.
    Buckets (evaluated on unrounded age):
      HOT: 0 - 24 hours (inclusive)
      FRESH: > 24 - 48 hours
      RECENT: > 48 - 72 hours
      STALE: > 72 hours
    """
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    target_dt = None
    is_observation_age = False
    date_inconsistent = False

    if posted_at is not None:
        if isinstance(posted_at, datetime):
            target_dt = posted_at if posted_at.tzinfo else posted_at.replace(tzinfo=timezone.utc)
        elif isinstance(posted_at, date):
            target_dt = datetime(posted_at.year, posted_at.month, posted_at.day, tzinfo=timezone.utc)
        elif isinstance(posted_at, str):
            try:
                parsed = datetime.fromisoformat(posted_at.replace("Z", "+00:00"))
                target_dt = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            except Exception:
                target_dt = None

    if target_dt is None:
        is_observation_age = True
        if observed_at:
            target_dt = observed_at if observed_at.tzinfo else observed_at.replace(tzinfo=timezone.utc)
        else:
            target_dt = current_time

    # Detect future timestamps
    if target_dt > current_time + timedelta(minutes=5):
        date_inconsistent = True
        diff_seconds = 0.0
    else:
        diff_seconds = max(0.0, (current_time - target_dt).total_seconds())

    raw_age_hours = diff_seconds / 3600.0
    display_age_hours = round(raw_age_hours, 1)

    # Unrounded boundary comparisons
    if raw_age_hours <= 24.0:
        bucket = "HOT"
    elif raw_age_hours <= 48.0:
        bucket = "FRESH"
    elif raw_age_hours <= 72.0:
        bucket = "RECENT"
    else:
        bucket = "STALE"

    confidence = 1.0
    if is_observation_age:
        confidence = 0.5
    elif date_inconsistent:
        confidence = 0.3

    return FreshnessResult(
        age_hours=display_age_hours,
        bucket=bucket,
        is_observation_age=is_observation_age,
        date_inconsistent=date_inconsistent,
        confidence=confidence,
        raw_age_hours=raw_age_hours
    )
