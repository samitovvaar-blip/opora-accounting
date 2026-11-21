#!/usr/bin/env python3
"""Local OPORA Accounting server and a credential-safe 1C OData gateway."""

from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024
FRESH_HOSTS = {"1cfresh.com", "www.1cfresh.com"}


def is_private_host(hostname: str) -> bool:
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except socket.gaierror:
        return False
    return bool(addresses) and all(ipaddress.ip_address(address).is_private for address in addresses)


def normalize_odata_url(raw_url: str, kind: str) -> str:
    url = raw_url.strip().rstrip("/")
    if not url:
        raise ValueError("Укажите адрес приложения 1С.")
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Укажите чистый адрес приложения без логина, параметров и фрагмента.")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Адрес должен начинаться с http:// или https://.")
    hostname = parsed.hostname.lower()
    if kind == "fresh":
        if parsed.scheme != "https" or hostname not in FRESH_HOSTS:
            raise ValueError("Для 1С:Фреш ожидается HTTPS-адрес на 1cfresh.com.")
        if not parsed.path.startswith("/a/"):
            raise ValueError("Скопируйте адрес приложения 1С:Фреш из адресной строки.")
    elif kind == "local":
        if not is_private_host(hostname):
            raise ValueError("Для локальной базы укажите адрес в локальной сети.")
    else:
        raise ValueError("Неизвестный тип подключения.")
    suffix = "/odata/standard.odata"
    return url if url.endswith(suffix) else url + suffix


def inspect_metadata(xml_bytes: bytes) -> dict[str, object]:
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as error:
        raise ValueError("1С вернула ответ, который не похож на OData metadata.") from error
    entity_sets = []
    for element in root.iter():
        if element.tag.endswith("EntitySet") and element.attrib.get("Name"):
            entity_sets.append(element.attrib["Name"])
    bank_documents = [
        name for name in entity_sets
        if name.startswith("Document_") and any(word in name.lower() for word in ("расчетн", "расчётн", "банк"))
    ]
    return {"entityCount": len(entity_sets), "bankDocuments": sorted(bank_documents)[:30]}


class Handler(SimpleHTTPRequestHandler):
    server_version = "OPORA-Accounting/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/api/1c/test":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Маршрут не найден."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("Некорректный размер запроса.")
            payload = json.loads(self.rfile.read(length))
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            if not username or not password:
                raise ValueError("Укажите служебный логин и пароль 1С.")
            odata_url = normalize_odata_url(str(payload.get("url", "")), str(payload.get("kind", "")))
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            request = urllib.request.Request(
                odata_url + "/$metadata",
                headers={"Authorization": "Basic " + token, "Accept": "application/xml"},
            )
            with urllib.request.urlopen(request, timeout=15, context=ssl.create_default_context()) as response:
                metadata = response.read(4 * 1024 * 1024)
            result = inspect_metadata(metadata)
            result.update({"ok": True, "odataUrl": odata_url})
            self.send_json(HTTPStatus.OK, result)
        except urllib.error.HTTPError as error:
            messages = {
                401: "1С отклонила логин или пароль.",
                403: "У пользователя нет права удалённого доступа OData.",
                404: "OData по этому адресу не найден. Проверьте публикацию и адрес приложения.",
            }
            self.send_json(error.code, {"error": messages.get(error.code, f"1С вернула HTTP {error.code}.")})
        except (urllib.error.URLError, TimeoutError):
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "Не удалось связаться с 1С. Проверьте адрес, сеть и публикацию."})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Не удалось проверить подключение."})


if __name__ == "__main__":
    port = int(os.environ.get("OPORA_PORT", "8000"))
    print(f"ОПОРА Бухгалтерия: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
