"""
Accessible, modern HTML/CSS/JS generator for the Morning Job Dashboard (Milestone 6).
Implements semantic tables, responsive filters, row expansion, sticky prepare toolbar,
native <dialog> outcomes, and strict WCAG AA / a11y standards.
"""
import json
from typing import Any, Dict, List


def render_briefing_dashboard_html(
    briefing: Dict[str, Any],
    items: List[Dict[str, Any]],
    csrf_token: str
) -> str:
    briefing_id = str(briefing["id"])
    schedule_name = briefing.get("schedule_name", "morning_scan")
    metrics = briefing.get("metrics") or {}
    source_status = metrics.get("source_status") or {}

    # Serialize items as JSON safely for clientside filter/sort
    items_json = json.dumps([
        {
            "job_id": str(it.get("job_id")),
            "rank": it.get("rank", 1),
            **(it.get("snapshot") or {})
        }
        for it in items
    ], default=str).replace("</script>", "<\\/script>")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{csrf_token}">
    <title>Morning Job Briefing - {schedule_name}</title>
    <style>
        :root {{
            --bg-color: #0d1117;
            --surface-color: #161b22;
            --surface-border: #30363d;
            --text-primary: #f0f6fc;
            --text-secondary: #8b949e;
            --accent-color: #238636;
            --accent-hover: #2ea043;
            --focus-ring: #58a6ff;
            --badge-hot: #da3633;
            --badge-fresh: #d29922;
            --badge-recent: #1f6feb;
            --badge-stale: #484f58;
            --badge-rec: #238636;
            --badge-consider: #8957e5;
            --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }}

        @media (prefers-color-scheme: light) {{
            :root {{
                --bg-color: #f6f8fa;
                --surface-color: #ffffff;
                --surface-border: #d0d7de;
                --text-primary: #1f2328;
                --text-secondary: #656d76;
                --accent-color: #1f883d;
                --accent-hover: #1a7f37;
                --focus-ring: #0969da;
                --badge-hot: #cf222e;
                --badge-fresh: #9a6700;
                --badge-recent: #0969da;
                --badge-stale: #8c959f;
                --badge-rec: #1a7f37;
                --badge-consider: #8250df;
            }}
        }}

        @media (prefers-reduced-motion: reduce) {{
            * {{
                animation-duration: 0.01ms !important;
                transition-duration: 0.01ms !important;
            }}
        }}

        *, *::before, *::after {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }}

        body {{
            font-family: var(--font-family);
            background-color: var(--bg-color);
            color: var(--text-primary);
            line-height: 1.5;
            padding-bottom: 100px;
        }}

        a {{
            color: var(--focus-ring);
            text-decoration: none;
        }}
        a:hover {{
            text-decoration: underline;
        }}

        :focus-visible {{
            outline: 2px solid var(--focus-ring);
            outline-offset: 2px;
        }}

        .sr-only {{
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
        }}

        header {{
            background-color: var(--surface-color);
            border-bottom: 1px solid var(--surface-border);
            padding: 1.5rem 2rem;
        }}

        .header-container {{
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        }}

        .title-group h1 {{
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text-primary);
        }}

        .title-group p {{
            font-size: 0.875rem;
            color: var(--text-secondary);
            margin-top: 0.25rem;
        }}

        .metrics-bar {{
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
        }}

        .metric-card {{
            background-color: var(--bg-color);
            border: 1px solid var(--surface-border);
            border-radius: 6px;
            padding: 0.5rem 0.875rem;
            text-align: center;
        }}

        .metric-val {{
            font-size: 1.125rem;
            font-weight: 700;
            color: var(--text-primary);
        }}

        .metric-lbl {{
            font-size: 0.75rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }}

        main {{
            max-width: 1400px;
            margin: 1.5rem auto;
            padding: 0 1.5rem;
        }}

        .controls-panel {{
            background-color: var(--surface-color);
            border: 1px solid var(--surface-border);
            border-radius: 8px;
            padding: 1rem 1.25rem;
            margin-bottom: 1.5rem;
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
            align-items: center;
            justify-content: space-between;
        }}

        .filter-group {{
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            align-items: center;
        }}

        .filter-label {{
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-secondary);
        }}

        select, input[type="text"] {{
            background-color: var(--bg-color);
            color: var(--text-primary);
            border: 1px solid var(--surface-border);
            border-radius: 6px;
            padding: 0.4rem 0.75rem;
            font-size: 0.875rem;
        }}

        .btn {{
            cursor: pointer;
            border-radius: 6px;
            padding: 0.45rem 0.9rem;
            font-size: 0.875rem;
            font-weight: 500;
            border: 1px solid var(--surface-border);
            background-color: var(--surface-color);
            color: var(--text-primary);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }}
        .btn:hover {{
            filter: brightness(1.1);
        }}

        .btn-primary {{
            background-color: var(--accent-color);
            color: #ffffff;
            border-color: var(--accent-color);
            font-weight: 600;
        }}
        .btn-primary:hover {{
            background-color: var(--accent-hover);
        }}

        .table-container {{
            background-color: var(--surface-color);
            border: 1px solid var(--surface-border);
            border-radius: 8px;
            overflow-x: auto;
        }}

        table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 0.875rem;
            text-align: left;
        }}

        th {{
            background-color: var(--bg-color);
            color: var(--text-secondary);
            font-weight: 600;
            padding: 0.75rem 1rem;
            border-bottom: 1px solid var(--surface-border);
            white-space: nowrap;
        }}

        td {{
            padding: 0.875rem 1rem;
            border-bottom: 1px solid var(--surface-border);
            vertical-align: middle;
        }}

        tr:hover {{
            background-color: rgba(255, 255, 255, 0.02);
        }}

        .badge {{
            display: inline-block;
            padding: 0.2rem 0.5rem;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            letter-spacing: 0.02em;
        }}
        .badge-rec {{ background: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.3); }}
        .badge-consider {{ background: rgba(137, 87, 229, 0.2); color: #bc8cff; border: 1px solid rgba(188, 140, 255, 0.3); }}
        .badge-hot {{ background: rgba(218, 54, 51, 0.2); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.3); }}
        .badge-fresh {{ background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.3); }}
        .badge-recent {{ background: rgba(31, 111, 235, 0.2); color: #58a6ff; border: 1px solid rgba(88, 166, 255, 0.3); }}
        .badge-stale {{ background: rgba(110, 118, 129, 0.2); color: #8b949e; border: 1px solid rgba(139, 148, 158, 0.3); }}

        .score-cell {{
            font-weight: 700;
            font-size: 0.95rem;
        }}

        .row-details-panel {{
            padding: 1rem 1.5rem;
            background-color: var(--bg-color);
            border-top: 1px dashed var(--surface-border);
            font-size: 0.8125rem;
        }}

        .details-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 1rem;
        }}

        .detail-box {{
            background: var(--surface-color);
            border: 1px solid var(--surface-border);
            border-radius: 6px;
            padding: 0.75rem 1rem;
        }}
        .detail-box h4 {{
            font-size: 0.8125rem;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
            text-transform: uppercase;
        }}
        .detail-box ul {{
            padding-left: 1.25rem;
        }}
        .detail-box li {{
            margin-bottom: 0.25rem;
        }}

        .sticky-toolbar {{
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background-color: var(--surface-color);
            border-top: 1px solid var(--surface-border);
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.3);
            z-index: 100;
        }}

        .sticky-container {{
            max-width: 1400px;
            margin: 0 auto;
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}

        dialog {{
            background-color: var(--surface-color);
            color: var(--text-primary);
            border: 1px solid var(--surface-border);
            border-radius: 8px;
            padding: 1.5rem 2rem;
            max-width: 600px;
            width: 90%;
            margin: auto;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        }}
        dialog::backdrop {{
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(2px);
        }}
        .dialog-header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }}
        .dialog-content {{
            max-height: 400px;
            overflow-y: auto;
            margin-bottom: 1.5rem;
        }}
        .outcome-item {{
            display: flex;
            justify-content: space-between;
            padding: 0.5rem 0;
            border-bottom: 1px solid var(--surface-border);
        }}
    </style>
</head>
<body>
    <header>
        <div class="header-container">
            <div class="title-group">
                <h1>🌅 Morning Job Search Briefing</h1>
                <p>Window: {briefing['window_started_at'].strftime('%b %d, %H:%M UTC')} → {briefing['window_ended_at'].strftime('%b %d, %H:%M UTC')}</p>
            </div>
            <div class="metrics-bar">
                <div class="metric-card">
                    <div class="metric-val">{metrics.get('newly_discovered_count', 0)}</div>
                    <div class="metric-lbl">New</div>
                </div>
                <div class="metric-card">
                    <div class="metric-val">{metrics.get('updated_count', 0)}</div>
                    <div class="metric-lbl">Updated</div>
                </div>
                <div class="metric-card">
                    <div class="metric-val">{len(items)}</div>
                    <div class="metric-lbl">Total</div>
                </div>
            </div>
        </div>
    </header>

    <main>
        <div class="controls-panel" role="region" aria-label="Filters and Sorting">
            <div class="filter-group">
                <label for="search-input" class="filter-label">Search:</label>
                <input type="text" id="search-input" placeholder="Filter title or company..." aria-label="Search jobs by title or company">

                <label for="filter-rec" class="filter-label">Rec:</label>
                <select id="filter-rec" aria-label="Filter by recommendation">
                    <option value="all">All Recommendations</option>
                    <option value="RECOMMENDED">Recommended Only</option>
                    <option value="CONSIDER">Consider & Above</option>
                </select>

                <label for="filter-remote" class="filter-label">Remote:</label>
                <select id="filter-remote" aria-label="Filter by work arrangement">
                    <option value="all">All Work Types</option>
                    <option value="Remote">Remote</option>
                    <option value="Hybrid">Hybrid</option>
                    <option value="On-site">On-site</option>
                </select>

                <label for="filter-freshness" class="filter-label">Freshness:</label>
                <select id="filter-freshness" aria-label="Filter by freshness">
                    <option value="all">All Postings</option>
                    <option value="HOT">HOT (0-24h)</option>
                    <option value="FRESH">FRESH (24-48h)</option>
                    <option value="RECENT">RECENT (48-72h)</option>
                    <option value="STALE">STALE (>72h)</option>
                </select>
            </div>

            <div class="filter-group">
                <label for="sort-select" class="filter-label">Sort:</label>
                <select id="sort-select" aria-label="Sort table">
                    <option value="score-desc">Overall Fit (High to Low)</option>
                    <option value="freshness-asc">Freshness (Newest)</option>
                    <option value="company-asc">Company (A to Z)</option>
                    <option value="title-asc">Role Title (A to Z)</option>
                </select>

                <button type="button" id="btn-select-all" class="btn">Select All Visible</button>
                <button type="button" id="btn-clear-all" class="btn">Clear Selection</button>
            </div>
        </div>

        <div class="table-container">
            <table id="job-table" aria-label="Morning Job Briefing Postings">
                <thead>
                    <tr>
                        <th scope="col" style="width: 40px;">
                            <input type="checkbox" id="select-all-header" aria-label="Select or deselect all jobs">
                        </th>
                        <th scope="col">Recommendation</th>
                        <th scope="col">Role & Company</th>
                        <th scope="col">Type</th>
                        <th scope="col">Location</th>
                        <th scope="col">Compensation</th>
                        <th scope="col">Freshness</th>
                        <th scope="col">Fit Score</th>
                        <th scope="col">Keywords</th>
                        <th scope="col">Evidence</th>
                        <th scope="col">Top Gap</th>
                        <th scope="col">Details</th>
                    </tr>
                </thead>
                <tbody id="table-body">
                    <!-- Populated dynamically via JavaScript -->
                </tbody>
            </table>
        </div>
    </main>

    <div class="sticky-toolbar" role="region" aria-label="Batch Actions">
        <div class="sticky-container">
            <div>
                <span id="selection-counter" aria-live="polite" style="font-weight: 600; margin-right: 1rem;">0 jobs selected</span>
                <span id="selection-note" style="font-size: 0.8125rem; color: var(--text-secondary);">Select jobs to queue requirement analysis and resume draft preparation.</span>
            </div>
            <div>
                <button type="button" id="btn-prepare-selected" class="btn btn-primary" disabled>
                    Prepare Selected
                </button>
            </div>
        </div>
    </div>

    <!-- Outcome Dialog -->
    <dialog id="outcome-dialog" aria-labelledby="dialog-title">
        <div class="dialog-header">
            <h2 id="dialog-title" style="font-size: 1.25rem;">Preparation Results</h2>
            <button type="button" id="btn-close-dialog" class="btn" aria-label="Close dialog">✕</button>
        </div>
        <div class="dialog-content" id="dialog-content">
            <!-- Results injected here -->
        </div>
        <div style="text-align: right;">
            <button type="button" class="btn btn-primary" onclick="document.getElementById('outcome-dialog').close()">Done</button>
        </div>
    </dialog>

    <script>
        const briefingId = "{briefing_id}";
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        const rawJobs = {items_json};

        let selectedJobIds = new Set();
        let visibleJobIds = [];

        function renderTable() {{
            const searchVal = document.getElementById('search-input').value.toLowerCase();
            const recVal = document.getElementById('filter-rec').value;
            const remoteVal = document.getElementById('filter-remote').value;
            const freshVal = document.getElementById('filter-freshness').value;
            const sortVal = document.getElementById('sort-select').value;

            // Filter
            let filtered = rawJobs.filter(j => {{
                if (searchVal) {{
                    const matchTitle = (j.title || '').toLowerCase().includes(searchVal);
                    const matchComp = (j.company || '').toLowerCase().includes(searchVal);
                    if (!matchTitle && !matchComp) return false;
                }}
                if (recVal !== 'all') {{
                    if (recVal === 'RECOMMENDED' && j.recommendation !== 'RECOMMENDED') return false;
                    if (recVal === 'CONSIDER' && !['RECOMMENDED', 'CONSIDER'].includes(j.recommendation)) return false;
                }}
                if (remoteVal !== 'all' && j.remote_type !== remoteVal) return false;
                if (freshVal !== 'all' && j.freshness !== freshVal) return false;
                return true;
            }});

            // Sort
            filtered.sort((a, b) => {{
                if (sortVal === 'score-desc') return (b.overall_score || 0) - (a.overall_score || 0);
                if (sortVal === 'company-asc') return (a.company || '').localeCompare(b.company || '');
                if (sortVal === 'title-asc') return (a.title || '').localeCompare(b.title || '');
                if (sortVal === 'freshness-asc') {{
                    const order = {{'HOT': 1, 'FRESH': 2, 'RECENT': 3, 'STALE': 4}};
                    return (order[a.freshness] || 5) - (order[b.freshness] || 5);
                }}
                return 0;
            }});

            visibleJobIds = filtered.map(j => j.job_id);

            const tbody = document.getElementById('table-body');
            tbody.innerHTML = '';

            filtered.forEach(j => {{
                const isSelected = selectedJobIds.has(j.job_id);
                const recClass = j.recommendation === 'RECOMMENDED' ? 'badge-rec' : 'badge-consider';
                const freshClass = 'badge-' + (j.freshness || 'recent').toLowerCase();
                const scoreText = j.overall_score !== null ? Math.round(j.overall_score) + '%' : 'Pending';
                const kwText = j.keyword_coverage !== null && j.keyword_coverage !== undefined ? Math.round(j.keyword_coverage) + '%' : '-';
                const evText = j.evidence_coverage !== null && j.evidence_coverage !== undefined ? Math.round(j.evidence_coverage) + '%' : '-';
                const topGapText = j.top_gap || 'None identified';

                const tr = document.createElement('tr');
                tr.id = 'row-' + j.job_id;
                tr.innerHTML = `
                    <td>
                        <input type="checkbox" class="job-checkbox" data-job-id="${{j.job_id}}"
                            aria-label="Select ${{j.title}} at ${{j.company}}"
                            ${{isSelected ? 'checked' : ''}}>
                    </td>
                    <td>
                        <span class="badge ${{recClass}}">${{j.recommendation || 'REVIEW'}}</span>
                    </td>
                    <td>
                        <strong>${{j.title}}</strong><br>
                        <span style="color: var(--text-secondary);">${{j.company}}</span>
                    </td>
                    <td>${{j.remote_type || 'On-site'}}</td>
                    <td>${{j.location || 'Remote'}}</td>
                    <td>${{j.compensation || 'Not disclosed'}}</td>
                    <td><span class="badge ${{freshClass}}">${{j.freshness}}</span></td>
                    <td class="score-cell">${{scoreText}}</td>
                    <td>${{kwText}}</td>
                    <td>${{evText}}</td>
                    <td style="max-width: 180px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${{topGapText}}">${{topGapText}}</td>
                    <td>
                        <button type="button" class="btn btn-toggle-details" data-job-id="${{j.job_id}}" aria-expanded="false" aria-controls="details-${{j.job_id}}">
                            Details
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);

                // Expandable row
                const detailsTr = document.createElement('tr');
                detailsTr.id = 'details-' + j.job_id;
                detailsTr.className = 'details-row';
                detailsTr.style.display = 'none';
                detailsTr.innerHTML = `
                    <td colspan="12" class="row-details-panel">
                        <div class="details-grid">
                            <div class="detail-box">
                                <h4>Top Strengths</h4>
                                <ul>${{(j.strengths || []).slice(0, 3).map(s => `<li>${{s}}</li>`).join('') || '<li>No explicit strengths recorded</li>'}}</ul>
                            </div>
                            <div class="detail-box">
                                <h4>Gaps & Risks</h4>
                                <ul>${{(j.gaps || []).slice(0, 3).map(g => `<li>${{g}}</li>`).join('') || '<li>No critical gaps detected</li>'}}</ul>
                            </div>
                            <div class="detail-box">
                                <h4>Post Provenance</h4>
                                <p style="margin-bottom: 0.5rem;">Source: <a href="${{j.source_url}}" target="_blank" rel="noopener noreferrer">View Original Posting</a></p>
                                <p style="color: var(--text-secondary); font-size: 0.75rem;">Job ID: ${{j.job_id}}</p>
                            </div>
                        </div>
                    </td>
                `;
                tbody.appendChild(detailsTr);
            }});

            updateSelectionUI();
        }}

        function updateSelectionUI() {{
            const counter = document.getElementById('selection-counter');
            const btnPrepare = document.getElementById('btn-prepare-selected');
            const count = selectedJobIds.size;
            counter.textContent = `${{count}} job${{count === 1 ? '' : 's'}} selected`;
            btnPrepare.disabled = count === 0;

            const headerCheck = document.getElementById('select-all-header');
            if (visibleJobIds.length > 0 && visibleJobIds.every(id => selectedJobIds.has(id))) {{
                headerCheck.checked = true;
                headerCheck.indeterminate = false;
            }} else if (visibleJobIds.some(id => selectedJobIds.has(id))) {{
                headerCheck.checked = false;
                headerCheck.indeterminate = true;
            }} else {{
                headerCheck.checked = false;
                headerCheck.indeterminate = false;
            }}
        }}

        // Event Listeners
        document.addEventListener('DOMContentLoaded', () => {{
            renderTable();

            // Table checkbox delegates
            document.getElementById('table-body').addEventListener('change', (e) => {{
                if (e.target.classList.contains('job-checkbox')) {{
                    const jid = e.target.getAttribute('data-job-id');
                    if (e.target.checked) selectedJobIds.add(jid);
                    else selectedJobIds.delete(jid);
                    updateSelectionUI();
                }}
            }});

            // Details toggle
            document.getElementById('table-body').addEventListener('click', (e) => {{
                if (e.target.classList.contains('btn-toggle-details')) {{
                    const jid = e.target.getAttribute('data-job-id');
                    const detailsRow = document.getElementById('details-' + jid);
                    const isExpanded = e.target.getAttribute('aria-expanded') === 'true';
                    e.target.setAttribute('aria-expanded', !isExpanded);
                    detailsRow.style.display = isExpanded ? 'none' : 'table-row';
                }}
            }});

            // Header checkbox
            document.getElementById('select-all-header').addEventListener('change', (e) => {{
                if (e.target.checked) {{
                    visibleJobIds.forEach(id => selectedJobIds.add(id));
                }} else {{
                    visibleJobIds.forEach(id => selectedJobIds.delete(id));
                }}
                renderTable();
            }});

            // Select all visible / clear
            document.getElementById('btn-select-all').addEventListener('click', () => {{
                visibleJobIds.forEach(id => selectedJobIds.add(id));
                renderTable();
            }});

            document.getElementById('btn-clear-all').addEventListener('click', () => {{
                selectedJobIds.clear();
                renderTable();
            }});

            // Filters & sort
            ['search-input', 'filter-rec', 'filter-remote', 'filter-freshness', 'sort-select'].forEach(id => {{
                document.getElementById(id).addEventListener('input', renderTable);
            }});

            // Prepare selected action
            document.getElementById('btn-prepare-selected').addEventListener('click', async () => {{
                if (selectedJobIds.size === 0) return;
                const btn = document.getElementById('btn-prepare-selected');
                btn.disabled = true;
                btn.textContent = 'Queueing...';

                const idempotencyKey = 'prep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
                const payload = {{
                    job_ids: Array.from(selectedJobIds),
                    idempotency_key: idempotencyKey
                }};

                try {{
                    const res = await fetch(`/api/briefings/${{briefingId}}/prepare`, {{
                        method: 'POST',
                        headers: {{
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrfToken
                        }},
                        body: JSON.stringify(payload)
                    }});

                    const data = await res.json();
                    if (!res.ok) throw new Error(data.message || 'Request failed');

                    // Render outcome dialog
                    const dialogContent = document.getElementById('dialog-content');
                    dialogContent.innerHTML = '';
                    const results = data.results || {{}};
                    Object.keys(results).forEach(jid => {{
                        const outcome = results[jid];
                        const job = rawJobs.find(x => x.job_id === jid) || {{title: 'Job ' + jid, company: ''}};
                        const itemDiv = document.createElement('div');
                        itemDiv.className = 'outcome-item';
                        itemDiv.innerHTML = `
                            <div>
                                <strong>${{job.title}}</strong> (${{job.company}})<br>
                                <span style="font-size: 0.75rem; color: var(--text-secondary);">${{outcome.reason || 'Preparation request active'}}</span>
                            </div>
                            <div>
                                <span class="badge ${{outcome.status === 'QUEUED' || outcome.status === 'ALREADY_PREPARED' ? 'badge-rec' : 'badge-hot'}}">
                                    ${{outcome.status}}
                                </span>
                            </div>
                        `;
                        dialogContent.appendChild(itemDiv);
                    }});

                    document.getElementById('outcome-dialog').showModal();
                    selectedJobIds.clear();
                    renderTable();
                }} catch (err) {{
                    alert('Failed to prepare selected jobs: ' + err.message);
                }} finally {{
                    btn.disabled = selectedJobIds.size === 0;
                    btn.textContent = 'Prepare Selected';
                }}
            }});

            document.getElementById('btn-close-dialog').addEventListener('click', () => {{
                document.getElementById('outcome-dialog').close();
            }});
        }});
    </script>
</body>
</html>
"""
