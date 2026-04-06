import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from jose import JWTError, jwt
import bcrypt
from sqlalchemy.orm import Session

from database import SessionLocal, User, TestSession, TestAttempt, init_db

# DATA_DIR: defaults to project root in dev, overridden to /app/data in Docker
DATA_DIR     = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent)))
TESTS_PATH   = DATA_DIR / "practice_tests.json"
ANSWERS_PATH = DATA_DIR / "answer_keys.json"

SECRET_KEY = "psycho-app-dev-secret-change-in-production"
ALGORITHM  = "HS256"
TOKEN_DAYS = 30

def _hash_pw(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def _verify_pw(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

app = FastAPI(title="Psychometric Test App")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

init_db()

_pdf_cache: dict[str, bytes] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def name_to_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def load_tests() -> list[dict]:
    raw: list[dict] = json.loads(TESTS_PATH.read_text(encoding="utf-8"))
    return [
        {"id": name_to_id(e["name"]), "name": e.get("name_he") or e["name"], "url": e["url"]}
        for e in raw if e.get("url", "").lower().endswith(".pdf")
    ]


def load_answers() -> dict:
    return json.loads(ANSWERS_PATH.read_text(encoding="utf-8"))


async def fetch_pdf(url: str) -> bytes:
    if url in _pdf_cache:
        return _pdf_cache[url]
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    _pdf_cache[url] = resp.content
    return resp.content


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def make_token(user_id: int, username: str) -> str:
    expire = datetime.utcnow() + timedelta(days=TOKEN_DAYS)
    return jwt.encode(
        {"sub": str(user_id), "username": username, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")


def current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    return decode_token(authorization[7:])


def optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return decode_token(authorization[7:])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/api/auth/register")
def register(payload: dict, db: Session = Depends(get_db)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if not username or len(username) < 2:
        raise HTTPException(400, "שם משתמש חייב להכיל לפחות 2 תווים")
    if len(password) < 4:
        raise HTTPException(400, "סיסמה חייבת להכיל לפחות 4 תווים")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "שם משתמש כבר קיים")
    user = User(username=username, password_hash=_hash_pw(password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"token": make_token(user.id, user.username), "username": user.username}


@app.post("/api/auth/login")
def login(payload: dict, db: Session = Depends(get_db)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    user = db.query(User).filter(User.username == username).first()
    if not user or not _verify_pw(password, user.password_hash):
        raise HTTPException(401, "שם משתמש או סיסמה שגויים")
    return {"token": make_token(user.id, user.username), "username": user.username}


# ---------------------------------------------------------------------------
# Stats routes
# ---------------------------------------------------------------------------

@app.post("/api/stats/record")
def record_session(payload: dict, user: dict = Depends(current_user), db: Session = Depends(get_db)):
    """
    payload: {
        pdf_id, pdf_name, mode, started_at (ISO string),
        results: [{key, section, part, correct, total, timing:[{q,ms,correct}]}]
    }
    Creates one TestSession and links all part results to it.
    """
    user_id  = int(user["sub"])
    pdf_id   = payload.get("pdf_id", "")
    pdf_name = payload.get("pdf_name", "")
    mode     = payload.get("mode", "regular")
    results  = payload.get("results", [])

    started_str = payload.get("started_at")
    try:
        started_at = datetime.fromisoformat(started_str) if started_str else datetime.utcnow()
    except Exception:
        started_at = datetime.utcnow()

    session = TestSession(
        user_id      = user_id,
        pdf_id       = pdf_id,
        pdf_name     = pdf_name,
        mode         = mode,
        started_at   = started_at,
        completed_at = datetime.utcnow(),
    )
    db.add(session)
    db.flush()   # populate session.id before linking attempts

    for r in results:
        timing = r.get("timing")
        attempt = TestAttempt(
            session_id   = session.id,
            section_key  = r.get("key", ""),
            section_name = r.get("section", ""),
            part_label   = r.get("part", ""),
            score        = r.get("correct", 0),
            total        = r.get("total", 0),
            timing_json  = json.dumps(timing, ensure_ascii=False) if timing else None,
        )
        db.add(attempt)

    db.commit()
    return {"ok": True}


@app.get("/api/stats")
def get_stats(user: dict = Depends(current_user), db: Session = Depends(get_db)):
    user_id = int(user["sub"])

    sessions = (
        db.query(TestSession)
        .filter(TestSession.user_id == user_id)
        .order_by(TestSession.completed_at.desc())
        .all()
    )

    by_test: dict[str, dict] = {}
    for s in sessions:
        if s.pdf_id not in by_test:
            by_test[s.pdf_id] = {
                "pdf_id":   s.pdf_id,
                "pdf_name": s.pdf_name,
                "sessions": [],
            }

        attempts = (
            db.query(TestAttempt)
            .filter(TestAttempt.session_id == s.id)
            .all()
        )
        session_score = sum(a.score for a in attempts)
        session_total = sum(a.total for a in attempts)

        by_test[s.pdf_id]["sessions"].append({
            "id":           s.id,
            "mode":         s.mode,
            "started_at":   s.started_at.isoformat() if s.started_at else None,
            "completed_at": s.completed_at.isoformat(),
            "score":        session_score,
            "total":        session_total,
            "attempts": [
                {
                    "id":           a.id,
                    "section_name": a.section_name,
                    "part_label":   a.part_label,
                    "score":        a.score,
                    "total":        a.total,
                    "timing":       json.loads(a.timing_json) if a.timing_json else None,
                }
                for a in attempts
            ],
        })

    all_scores   = [s["score"] for t in by_test.values() for s in t["sessions"]]
    all_totals   = [s["total"] for t in by_test.values() for s in t["sessions"]]
    total_score  = sum(all_scores)
    total_possible = sum(all_totals)

    return {
        "username":          user["username"],
        "total_sessions":    len(sessions),
        "total_score":       total_score,
        "total_possible":    total_possible,
        "tests":             list(by_test.values()),
        "completed_pdf_ids": list(by_test.keys()),
    }


# ---------------------------------------------------------------------------
# PDF / answers routes
# ---------------------------------------------------------------------------

@app.get("/api/pdfs")
async def list_pdfs():
    answers = load_answers()
    return [
        {"id": t["id"], "name": t["name"]}
        for t in load_tests()
        if t["id"] in answers
    ]


@app.get("/api/pdf/{pdf_id}/file")
async def proxy_pdf(pdf_id: str):
    tests = {t["id"]: t for t in load_tests()}
    if pdf_id not in tests:
        raise HTTPException(404, "PDF not found")
    pdf_bytes = await fetch_pdf(tests[pdf_id]["url"])
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": "inline; filename=test.pdf"},
    )


@app.get("/api/pdf/{pdf_id}/answers")
async def get_answers(pdf_id: str):
    answers = load_answers()
    if pdf_id not in answers:
        raise HTTPException(404, "No answer key found for this test")
    return answers[pdf_id]


@app.post("/api/pdf/{pdf_id}/grade")
async def grade(pdf_id: str, payload: dict):
    key_data = (load_answers()).get(pdf_id)
    if not key_data:
        raise HTTPException(404, "No answer key found for this test")

    user_answers: dict = payload.get("answers", {})
    results = []

    for section in key_data["sections"]:
        for part in section["parts"]:
            slot = f"{section['key']}__{part['label']}"
            user_part    = user_answers.get(slot, {})
            correct_map: dict = part["answers"]

            details, n_correct = {}, 0
            for q, correct_ans in correct_map.items():
                given = user_part.get(q)
                ok    = given == correct_ans
                if ok:
                    n_correct += 1
                details[q] = {"given": given, "correct": correct_ans, "is_correct": ok}

            results.append({
                "section": section["name"],
                "key":     section["key"],
                "part":    part["label"],
                "slot":    slot,
                "correct": n_correct,
                "total":   len(correct_map),
                "details": details,
            })

    return {
        "total_correct":   sum(r["correct"] for r in results),
        "total_questions": sum(r["total"]   for r in results),
        "results":         results,
    }


# Serve frontend (must be last)
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    print(f"Starting at http://localhost:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
