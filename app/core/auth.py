from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

from fastapi import Request, HTTPException

from app import user_context


@dataclass(frozen=True)
class Actor:
    """Кто выполняет запрос. Попадает в журнал действий (audit.db_actions).

    kind: 'user'      — администратор, пришедший через шлюз (известен его X-User-Id);
          'token'     — вызов по общему Bearer-токену: личность неизвестна, известно лишь,
                        что у вызывающего есть токен;
          'anonymous' — авторизация отключена явным DBSVC_ALLOW_NO_AUTH.
    """

    kind: str
    user_id: str | None = None
    role: str | None = None
    ip: str | None = None


def auth_is_disabled() -> bool:
    """Разрешено ли работать без токена.

    Раньше пустой DBSVC_ADMIN_TOKEN просто отключал проверку — то есть забытая переменная
    окружения молча открывала CRUD по всей базе (включая auth.users) и удаление файлов.
    Теперь отключение должно быть заявлено явно: одной забытой переменной недостаточно.
    """
    return os.getenv("DBSVC_ALLOW_NO_AUTH", "").strip().lower() in ("1", "true", "yes")


def admin_token() -> str:
    return os.getenv("DBSVC_ADMIN_TOKEN", "").strip()


def _verified_gateway_context(request: Request) -> user_context.UserContext | None:
    """Администратор, подтверждённый шлюзом, или None.

    Раньше db-svc верил заголовку X-User-Role, который выставлял nginx, и это было безопасно
    ровно пока порт контейнера не опубликован: любой, кто достучался бы напрямую, мог назвать
    себя админом. Теперь шлюз передаёт подписанный auth-svc контекст (app/user_context.py,
    аудитория db-svc), и подделать его без ключа нельзя. Админская роль проверяется по
    подписанному утверждению, а не по заголовку.
    """
    signed = request.headers.get(user_context.HEADER)
    if signed:
        try:
            ctx = user_context.verify_from_env(signed)
        except user_context.UserContextError:
            raise HTTPException(status_code=401, detail="Invalid user context")
        if ctx.role != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        return ctx
    # Переходный режим (USER_CONTEXT_ALLOW_LEGACY): прежние голые заголовки от nginx.
    if user_context.allow_legacy():
        if (request.headers.get("x-user-role") or "").strip().lower() == "admin":
            return user_context.UserContext(
                user_id=_legacy_user_id(request) or "", role="admin", audience="db-svc", expires_at=0
            )
    return None


def _legacy_user_id(request: Request) -> str | None:
    raw = (request.headers.get("x-user-id") or "").strip()
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def _client_ip(request: Request, via_gateway: bool) -> str | None:
    # За шлюзом реальный адрес лежит в X-Real-IP (nginx его проставляет); подлинность шлюза
    # подтверждена подписанным контекстом. Без шлюза заголовку верить нельзя, берём адрес сокета.
    if via_gateway:
        forwarded = (request.headers.get("x-real-ip") or "").strip()
        if forwarded:
            return forwarded[:64]
    return request.client.host if request.client else None


def verify_auth_configuration() -> None:
    """Проверка конфигурации при запуске. Вызывается из lifespan в app/main.py."""
    # Ключ проверки контекста от шлюза: без него админка за nginx не заработает, а принимать
    # неподписанное нельзя.
    user_context.check_configuration()
    if admin_token():
        return
    if auth_is_disabled():
        return
    raise RuntimeError(
        "DBSVC_ADMIN_TOKEN не задан. db-svc даёт полный доступ к базе и хранилищу файлов, "
        "поэтому запуск без токена запрещён. Задайте DBSVC_ADMIN_TOKEN либо, если это "
        "осознанно и только локально, установите DBSVC_ALLOW_NO_AUTH=true."
    )


def require_auth(request: Request) -> Actor:
    """Проверка доступа для всех /api/*. Возвращает того, кто вызывает.

    Два способа: подписанный контекст администратора от шлюза либо Bearer-токен.

    Отсутствие токена в конфигурации здесь уже не означает «пропустить»: такое состояние
    отсекается при запуске (verify_auth_configuration) и допускается только при явном
    DBSVC_ALLOW_NO_AUTH.
    """
    # Запрос пришёл через gateway, который проверил админ-сессию, и auth-svc это подписал.
    ctx = _verified_gateway_context(request)
    if ctx is not None:
        return Actor(
            kind="user",
            user_id=ctx.user_id or None,
            role="admin",
            ip=_client_ip(request, via_gateway=True),
        )

    ip = _client_ip(request, via_gateway=False)
    token_expected = admin_token()
    if not token_expected:
        if auth_is_disabled():
            return Actor(kind="anonymous", ip=ip)
        # Сюда попасть можно только если переменные изменили уже после старта.
        raise HTTPException(status_code=503, detail="Auth is not configured")

    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    parts = auth.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Use: Authorization: Bearer <token>")

    if parts[1] != token_expected:
        raise HTTPException(status_code=403, detail="Invalid token")

    return Actor(kind="token", ip=ip)
