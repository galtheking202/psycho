import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker
from pathlib import Path
from datetime import datetime

# Support PostgreSQL on Railway via DATABASE_URL env var; fall back to SQLite for local dev
_db_url = os.getenv("DATABASE_URL")
if not _db_url:
    _sqlite_path = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent))) / "psycho.db"
    _db_url = f"sqlite:///{_sqlite_path}"

# Railway injects postgres:// but SQLAlchemy needs postgresql://
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

_connect_args = {"check_same_thread": False} if _db_url.startswith("sqlite") else {}
engine        = create_engine(_db_url, connect_args=_connect_args)
SessionLocal  = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base          = declarative_base()


class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True, index=True)
    username      = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow)


class TestAttempt(Base):
    __tablename__ = "test_attempts"
    id           = Column(Integer, primary_key=True, index=True)
    user_id      = Column(Integer, ForeignKey("users.id"), nullable=False)
    pdf_id       = Column(String, nullable=False)
    pdf_name     = Column(String, nullable=False)
    section_key  = Column(String, nullable=False)
    section_name = Column(String, nullable=False)
    part_label   = Column(String, nullable=False)
    score        = Column(Integer, nullable=False)
    total        = Column(Integer, nullable=False)
    timing_json  = Column(String, nullable=True)   # JSON array [{q,ms}, ...]
    completed_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)
