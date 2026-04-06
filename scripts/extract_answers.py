"""
One-time script: downloads every PDF in practice_tests.json,
reads the answer tables from the last pages, and writes answer_keys.json.

Run from the project root:
    python scripts/extract_answers.py
"""

import io
import json
import re
import sys
import time
from pathlib import Path

import httpx
import pdfplumber

ROOT = Path(__file__).parent.parent
TESTS_PATH = ROOT / "practice_tests.json"
OUT_PATH = ROOT / "answer_keys.json"
PAGES_FROM_END = 4   # how many pages from the end to scan

# ---------------------------------------------------------------------------
# Reversed-Hebrew keyword maps (PDF stores Hebrew in visual/reversed order)
# ---------------------------------------------------------------------------
SECTION_MAP = {
    "תילולימ": "חישוב מילולית",
    "תיתומכ":  "חישוב כמותית",
    "תילגנא":  "אנגלית",
    "ארקנה":   "הבנת הנקרא",   # less common
}
PART_MAP = {
    "ןושאר": "פרק ראשון",
    "ינש":   "פרק שני",
    "ישילש": "פרק שלישי",
    "יעיבר": "פרק רביעי",
}


def name_to_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def parse_title(line: str) -> tuple[str, str] | None:
    """Return (section_name, part_name) if the line is a section title, else None."""
    section = next((v for k, v in SECTION_MAP.items() if k in line), None)
    if not section:
        return None
    part = next((v for k, v in PART_MAP.items() if k in line), "")
    return section, part


def is_all_digits(line: str) -> list[int] | None:
    """If every token on the line is a digit, return the list of ints, else None."""
    tokens = line.split()
    if not tokens:
        return None
    if all(t.isdigit() for t in tokens):
        return [int(t) for t in tokens]
    return None


def parse_answer_page_text(page_text: str) -> list[dict]:
    """
    Parse one page's text into a list of {section, part, answers}.

    The answer-key page text looks like:
        ןושאר קרפ - תילולימ הבישח       ← title (reversed Hebrew)
        רפסמ                              ← row label (ignored)
        23 22 21 20 ... 1                 ← question numbers (max > 4)
        הלאשה                             ← row label (ignored)
        הבושתה                            ← row label (ignored)
        3 4 4 4 4 3 1 ...                 ← correct answers (all 1-4)
        הנוכנה                            ← row label (ignored)
    """
    lines = page_text.splitlines()
    blocks = []
    current_section = None
    current_part = ""
    q_nums: list[int] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Title line?
        parsed = parse_title(line)
        if parsed:
            current_section, current_part = parsed
            q_nums = []
            continue

        # Number-only line?
        nums = is_all_digits(line)
        if nums and len(nums) >= 5:
            if max(nums) > 4:
                # Question-numbers line
                q_nums = nums
            elif q_nums and all(1 <= n <= 4 for n in nums) and len(nums) == len(q_nums):
                # Answers line — zip with previously captured q_nums
                if current_section:
                    answers = {str(q): str(a) for q, a in zip(q_nums, nums)}
                    blocks.append({
                        "section": current_section,
                        "part": current_part,
                        "answers": answers,
                    })
                q_nums = []   # reset so we don't double-capture

    return blocks


def group_blocks(blocks: list[dict]) -> list[dict]:
    """Convert flat [{section, part, answers}] → [{name, key, parts:[{label, answers}]}]."""
    seen: dict[str, dict] = {}
    ordered: list[dict] = []
    for blk in blocks:
        sname = blk["section"]
        if sname not in seen:
            entry = {"name": sname, "key": f"section_{len(seen)}", "parts": []}
            seen[sname] = entry
            ordered.append(entry)
        seen[sname]["parts"].append({"label": blk["part"], "answers": blk["answers"]})
    return ordered


def extract_test(name: str, name_he: str, url: str) -> dict | None:
    print(f"  Downloading …", end="", flush=True)
    try:
        resp = httpx.get(url, timeout=120, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        print(f" FAILED ({e})")
        return None

    pdf_bytes = resp.content
    print(f" {len(pdf_bytes):,} bytes", end="", flush=True)

    all_blocks: list[dict] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total = len(pdf.pages)
            start = max(0, total - PAGES_FROM_END)
            for page in pdf.pages[start:]:
                text = page.extract_text() or ""
                all_blocks.extend(parse_answer_page_text(text))
    except Exception as e:
        print(f" PARSE ERROR ({e})")
        return None

    if not all_blocks:
        print(" NO ANSWERS FOUND")
        return None

    sections = group_blocks(all_blocks)
    total_q = sum(len(p["answers"]) for s in sections for p in s["parts"])
    print(f" → {len(sections)} sections, {total_q} questions total ✓")
    return {"name": name_he or name, "url": url, "sections": sections}


def main():
    tests_raw: list[dict] = json.loads(TESTS_PATH.read_text(encoding="utf-8"))

    # Load existing output so we can skip already-done tests
    existing: dict = {}
    if OUT_PATH.exists():
        existing = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        print(f"Resuming — {len(existing)} tests already in {OUT_PATH.name}\n")

    result: dict = dict(existing)

    for entry in tests_raw:
        url: str = entry.get("url", "")
        if not url.lower().endswith(".pdf"):
            continue  # skip non-PDF entries

        name: str = entry["name"]
        name_he: str = entry.get("name_he", name)
        tid = name_to_id(name)

        if tid in result:
            print(f"[SKIP] {name}")
            continue

        print(f"[{name}]")
        data = extract_test(name, name_he, url)
        if data:
            result[tid] = data

        # Save after every test so a crash doesn't lose progress
        OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(1)   # be polite to the server

    print(f"\nDone. Wrote {len(result)} tests to {OUT_PATH}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
