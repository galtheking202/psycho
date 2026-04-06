import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker
from pathlib import Path
from datetime import datetime

# Support PostgreSQL on Railway; fall back to SQLite for local dev
_db_url = os.getenv("DATABASE_URL")
if not _db_url:
    _sqlite_path = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent))) / "psycho.db"
    _db_url = f"sqlite:///{_sqlite_path}"

if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

_connect_args = {"check_same_thread": False} if _db_url.startswith("sqlite") else {}
engine       = create_engine(_db_url, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base         = declarative_base()


class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True, index=True)
    username      = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow)


class TestSession(Base):
    """One test run (simulation or regular) by a user."""
    __tablename__ = "test_sessions"
    id           = Column(Integer, primary_key=True, index=True)
    user_id      = Column(Integer, ForeignKey("users.id"), nullable=False)
    pdf_id       = Column(String, nullable=False)
    pdf_name     = Column(String, nullable=False)
    mode         = Column(String, nullable=False, default="regular")  # "simulation" | "regular"
    started_at   = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, default=datetime.utcnow)


class TestAttempt(Base):
    """One part (פרק) result within a session."""
    __tablename__ = "test_attempts"
    id           = Column(Integer, primary_key=True, index=True)
    session_id   = Column(Integer, ForeignKey("test_sessions.id"), nullable=False)
    section_key  = Column(String, nullable=False)
    section_name = Column(String, nullable=False)
    part_label   = Column(String, nullable=False)
    score        = Column(Integer, nullable=False)
    total        = Column(Integer, nullable=False)
    timing_json  = Column(String, nullable=True)   # JSON [{q, ms, correct}, ...]


def init_db():
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)

    # One-time migration: if test_attempts exists without session_id, drop both tables
    if "test_attempts" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("test_attempts")}
        if "session_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("DROP TABLE IF EXISTS test_attempts"))
                conn.execute(text("DROP TABLE IF EXISTS test_sessions"))

    Base.metadata.create_all(bind=engine)
