import re
import hashlib
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

def clean_url(url: str) -> str:
    """
    Strips tracking parameters (utm_*, ref, source, etc.) while preserving
    canonical job identifiers (e.g. jk for Indeed, currentJobId for LinkedIn).
    """
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        # Parse query string
        qs = parse_qs(parsed.query)
        allowed_params = {}
        for k, v in qs.items():
            k_lower = k.lower()
            if k_lower.startswith("utm_") or k_lower in [
                "ref", "source", "tracking", "fbclid", "gclid", "campaign",
                "spJobID", "spPostingID", "from", "trk", "trackingid"
            ]:
                continue
            allowed_params[k] = v[0] if len(v) == 1 else v

        # Standardize Indeed URLs
        if "indeed." in parsed.netloc and "jk" in allowed_params:
            return f"https://ca.indeed.com/viewjob?jk={allowed_params['jk']}"
        
        # Standardize LinkedIn URLs
        if "linkedin.com" in parsed.netloc:
            # Match /jobs/view/123456789
            match = re.search(r'/jobs/view/(\d+)', parsed.path)
            if match:
                return f"https://www.linkedin.com/jobs/view/{match.group(1)}"
            if "currentJobId" in allowed_params:
                return f"https://www.linkedin.com/jobs/view/{allowed_params['currentJobId']}"

        # General rebuild
        new_query = urlencode(allowed_params, doseq=True)
        return urlunparse((
            parsed.scheme,
            parsed.netloc.lower(),
            parsed.path.rstrip('/'),
            parsed.params,
            new_query,
            ""
        ))
    except Exception:
        return url.strip()

def normalize_title(title: str) -> str:
    """
    Maps varying job title strings into canonical role titles.
    """
    if not title:
        return "Unknown Role"
    t = title.strip()
    t_lower = t.lower()

    if "technical product manager" in t_lower or "product manager, technical" in t_lower or "product manager - technical" in t_lower:
        if "senior" in t_lower or "sr" in t_lower or "lead" in t_lower:
            return "Senior Technical Product Manager"
        return "Technical Product Manager"
    
    if "senior product manager" in t_lower or "sr. product manager" in t_lower or "sr product manager" in t_lower:
        return "Senior Product Manager"
    
    if "lead product manager" in t_lower:
        return "Lead Product Manager"

    if "principal product manager" in t_lower:
        return "Principal Product Manager"

    if "product manager" in t_lower:
        return "Product Manager"

    return t

def normalize_location(location: str, is_remote: bool = False) -> tuple[str, str]:
    """
    Returns (cleaned_location, remote_type).
    remote_type is one of: 'remote', 'hybrid', 'onsite', 'unknown'.
    """
    if not location:
        return ("Remote Canada" if is_remote else "Canada", "remote" if is_remote else "unknown")
    
    loc = location.strip()
    loc_lower = loc.lower()

    if is_remote or "remote" in loc_lower:
        remote_type = "remote"
    elif "hybrid" in loc_lower:
        remote_type = "hybrid"
    else:
        remote_type = "onsite"

    if "toronto" in loc_lower:
        cleaned_loc = "Toronto, ON, Canada"
    elif "ontario" in loc_lower or ", on" in loc_lower:
        cleaned_loc = "Ontario, Canada"
    elif "remote" in loc_lower:
        cleaned_loc = "Remote Canada"
    else:
        cleaned_loc = loc

    return (cleaned_loc, remote_type)

def generate_content_hash(company: str, title: str, description: str) -> str:
    """
    Creates a deterministic hash based on company, normalized title, and text content.
    """
    clean_desc = re.sub(r'\s+', ' ', (description or "")).strip().lower()
    payload = f"{company.strip().lower()}|{title.strip().lower()}|{clean_desc[:500]}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
