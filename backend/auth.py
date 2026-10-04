"""Administrator sessions. Public observatory data never requires a token."""

import hashlib
import hmac
import secrets
import time
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from .db import connect, one, audit

COOKIE = "seismicx_admin"
TTL = 12 * 3600
router = APIRouter(prefix="/api/auth", tags=["administration"])


def init_auth():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS admin_account (
          id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS login_failures (address TEXT NOT NULL, stamp REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS login_failure_time ON login_failures(stamp);
        """)


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return salt.hex() + ":" + digest.hex()


def verify(password, stored):
    salt, digest = stored.split(":")
    actual = hashlib.scrypt(
        password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
    )
    return hmac.compare_digest(actual.hex(), digest)


def identity(request):
    token = request.cookies.get(COOKIE, "")
    if not token or len(token) > 128:
        return None
    row = one(
        "SELECT token_hash,csrf,expires,username FROM admin_sessions CROSS JOIN admin_account WHERE token_hash=? AND expires>?",
        (hashlib.sha256(token.encode()).hexdigest(), time.time()),
    )
    return row


def same_origin(request):
    origin = request.headers.get("origin")
    return not origin or origin.rstrip("/") == str(request.base_url).rstrip("/")


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class Credentials(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(default="", max_length=128)


def bootstrap(username, password):
    Credentials(current_password=password, username=username, password=password)
    if len(password) < 8:
        raise ValueError("密码至少 8 位")
    init_auth()
    digest = password_hash(password)
    with connect() as db:
        db.execute(
            "INSERT OR REPLACE INTO admin_account VALUES (1,?,?)", (username, digest)
        )
        db.execute("DELETE FROM admin_sessions")


@router.post("/login")
def login(data: Login, request: Request, response: Response):
    if not same_origin(request):
        raise HTTPException(403, "请从本站后台登录")
    address = request.client.host if request.client else "unknown"
    current = time.time()
    with connect() as db:
        db.execute("DELETE FROM login_failures WHERE stamp<?", (current - 300,))
        db.execute("DELETE FROM admin_sessions WHERE expires<?", (current,))
        failures = db.execute(
            "SELECT count(*) FROM login_failures WHERE address=?", (address,)
        ).fetchone()[0]
        if failures >= 10:
            raise HTTPException(429, "登录尝试过多，请 5 分钟后重试")
    account = one("SELECT * FROM admin_account WHERE id=1")
    # A dummy hash keeps unknown-account verification on the same expensive path.
    valid = verify(
        data.password,
        account["password_hash"] if account else "00" * 16 + ":" + "00" * 64,
    )
    if (
        not account
        or not valid
        or not hmac.compare_digest(data.username.encode(), account["username"].encode())
    ):
        with connect() as db:
            db.execute("INSERT INTO login_failures VALUES (?,?)", (address, current))
        raise HTTPException(401, "用户名或密码不正确")
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    expires = current + TTL
    with connect() as db:
        db.execute(
            "INSERT INTO admin_sessions VALUES (?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), csrf, expires),
        )
        db.execute("DELETE FROM login_failures WHERE address=?", (address,))
    response.set_cookie(
        COOKIE,
        token,
        max_age=TTL,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        path="/api",
    )
    return {
        "authenticated": True,
        "username": account["username"],
        "csrf": csrf,
        "expires": expires,
    }


@router.get("/session")
def session(request: Request):
    user = request.state.admin
    return {
        "authenticated": bool(user),
        **({k: user[k] for k in ("username", "csrf", "expires")} if user else {}),
    }


@router.post("/logout")
def logout(request: Request, response: Response):
    with connect() as db:
        db.execute(
            "DELETE FROM admin_sessions WHERE token_hash=?",
            (request.state.admin["token_hash"],),
        )
    response.delete_cookie(COOKIE, path="/api")
    return {"ok": True}


@router.put("/credentials")
def credentials(data: Credentials, request: Request, response: Response):
    account = one("SELECT * FROM admin_account WHERE id=1")
    if not verify(data.current_password, account["password_hash"]):
        raise HTTPException(403, "当前密码不正确")
    if data.password and len(data.password) < 8:
        raise HTTPException(422, "新密码至少 8 位")
    digest = password_hash(data.password) if data.password else account["password_hash"]
    with connect() as db:
        db.execute(
            "UPDATE admin_account SET username=?,password_hash=? WHERE id=1",
            (data.username, digest),
        )
        db.execute("DELETE FROM admin_sessions")
        audit(
            db,
            "admin",
            "1",
            {"username": account["username"]},
            {"username": data.username},
            "更新后台账号并撤销所有登录会话",
        )
    response.delete_cookie(COOKIE, path="/api")
    return {"ok": True, "message": "账号已更新，请重新登录"}
