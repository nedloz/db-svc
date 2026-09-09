from __future__ import annotations

import os
from fastapi import Request, HTTPException


def auth_is_disabled() -> bool:
    """Разрешено ли работать без токена.

    Раньше пустой DBSVC_ADMIN_TOKEN просто отключал проверку — то есть забытая переменная
    окружения молча открывала CRUD по всей базе (включая auth.users) и удаление файлов.
    Теперь отключение должно быть заявлено явно: одной забытой переменной недостаточно.
    """
    return os.getenv("DBSVC_ALLOW_NO_AUTH", "").strip().lower() in ("1", "true", "yes")


def admin_token() -> str:
    return os.getenv("DBSVC_ADMIN_TOKEN", "").strip()


def gateway_role_trusted() -> bool:
    """Доверять ли заголовку X-User-Role от gateway.

    Тот же приём, что у chat-svc с X-User-Id: nginx проверяет админ-сессию
    (auth_request /auth/validate-admin) и только после этого проксирует запрос сюда,
    проставляя роль. Благодаря этому Bearer-токен db-svc не нужен в браузере.

    Безопасно это ровно до тех пор, пока порт db-svc не опубликован наружу: любой, кто
    достучится до контейнера напрямую, сможет подделать заголовок. Отсюда и флаг —
    при публикации порта доверие нужно отключать.
    """
    return os.getenv("DBSVC_TRUST_GATEWAY_ROLE", "true").strip().lower() in ("1", "true", "yes")


def _gateway_admin(request: Request) -> bool:
    if not gateway_role_trusted():
        return False
    role = (request.headers.get("x-user-role") or "").strip().lower()
    return role == "admin"


def verify_auth_configuration() -> None:
    """Проверка конфигурации при запуске. Вызывается из lifespan в app/main.py."""
    if admin_token():
        return
    if auth_is_disabled():
        return
    raise RuntimeError(
        "DBSVC_ADMIN_TOKEN не задан. db-svc даёт полный доступ к базе и хранилищу файлов, "
        "поэтому запуск без токена запрещён. Задайте DBSVC_ADMIN_TOKEN либо, если это "
        "осознанно и только локально, установите DBSVC_ALLOW_NO_AUTH=true."
    )


def require_auth(request: Request) -> None:
    """Проверка Bearer-токена для всех /api/*.

    Отсутствие токена в конфигурации здесь уже не означает «пропустить»: такое состояние
    отсекается при запуске (verify_auth_configuration) и допускается только при явном
    DBSVC_ALLOW_NO_AUTH.
    """
    # Запрос пришёл через gateway, который уже проверил админ-сессию.
    if _gateway_admin(request):
        return

    token_expected = admin_token()
    if not token_expected:
        if auth_is_disabled():
            return
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
