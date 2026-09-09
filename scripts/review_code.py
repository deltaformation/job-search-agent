#!/usr/bin/env python3
"""
Code Review Agent powered by Claude Code CLI.
Analyzes git diffs, staged changes, or target files against project standards in CLAUDE.md.
"""
import sys
import os
import subprocess
import argparse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CLAUDE_BIN = os.getenv("CLAUDE_BIN", "/Users/mouadatfi/.local/bin/claude")

def get_git_diff(target: str = "staged") -> str:
    try:
        if target == "staged":
            cmd = ["git", "diff", "--cached"]
        elif target == "working":
            cmd = ["git", "diff"]
        elif target == "last-commit":
            # Check if there is more than 1 commit
            rev_count = subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=BASE_DIR, capture_output=True, text=True).stdout.strip()
            if rev_count == "1":
                cmd = ["git", "show", "HEAD"]
            else:
                cmd = ["git", "diff", "HEAD~1", "HEAD"]
        elif target == "all":
            cmd = ["git", "diff", "HEAD"]
        else:
            cmd = ["git", "diff", target]
        
        res = subprocess.run(cmd, cwd=BASE_DIR, capture_output=True, text=True, check=True)
        return res.stdout.strip()
    except Exception as e:
        print(f"Error fetching git diff: {e}", file=sys.stderr)
        return ""

def run_claude_review(diff_text: str, context: str = "") -> str:
    if not os.path.exists(CLAUDE_BIN):
        return f"Error: Claude CLI binary not found at {CLAUDE_BIN}"

    if not diff_text and not context:
        # Fallback: review recent codebase structure
        diff_summary = "No uncommitted diffs found. Please review the repository architecture and code quality in services/, db/, and tests/ against CLAUDE.md guidelines."
    else:
        diff_summary = f"Code diff to review:\n```diff\n{diff_text[:15000]}\n```"

    prompt = f"""
You are an expert Principal Software Engineer and Code Reviewer for the Job Search Operating System repository.
Read and enforce all standards defined in CLAUDE.md.

Context: {context or 'Pre-commit / milestone review'}

{diff_summary}

Provide a structured, rigorous code review including:
1. Executive Summary & Quality Verdict (Approved / Changes Requested)
2. Domain & Truthfulness Adherence (fact_id provenance, no hallucinated experience, gap marking)
3. Architecture & Error Handling (multi-source scraping, database reliability, JSON/Decimal serialization)
4. Security & Safety (credentials, human-in-the-loop gates)
5. Test Coverage & Edge Cases
6. Actionable Recommendations (prioritized by Critical, Warning, Suggestion)
"""

    cmd = [
        CLAUDE_BIN,
        "-p",
        prompt,
        "--permission-mode", "dontAsk"
    ]

    try:
        print("Invoking Claude Code Review Agent...")
        res = subprocess.run(
            cmd,
            cwd=BASE_DIR,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=180
        )
        if res.returncode == 0:
            return res.stdout.strip()
        else:
            return f"Claude review failed (exit code {res.returncode}):\n{res.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return "Error: Claude Code review timed out after 180 seconds."
    except Exception as e:
        return f"Exception during Claude Code review: {str(e)}"

def main() -> None:
    parser = argparse.ArgumentParser(description="Run Claude Code Review on Job Search Agent repository.")
    parser.add_argument(
        "--target",
        choices=["staged", "working", "last-commit", "all"],
        default="all",
        help="Git diff target to review (default: all)"
    )
    parser.add_argument("--context", type=str, default="", help="Optional context or focus areas")
    args = parser.parse_args()

    diff_content = get_git_diff(args.target)
    review_output = run_claude_review(diff_content, args.context)
    print("\n" + "=" * 60)
    print("CLAUDE CODE REVIEW REPORT")
    print("=" * 60 + "\n")
    print(review_output)
    print("\n" + "=" * 60 + "\n")

if __name__ == "__main__":
    main()
