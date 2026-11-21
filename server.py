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
MAX_METADATA = 32 * 1024 * 1024
FRESH_HOSTS = {"1cfresh.com", "www.1cfresh.com"}
ACTIVE_CONNECTION: dict[str, str] = {}


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
        is_fresh_host = hostname in FRESH_HOSTS or hostname.endswith(".1cfresh.com")
        if parsed.scheme != "https" or not is_fresh_host:
            raise ValueError("Для 1С:Фреш ожидается HTTPS-адрес на 1cfresh.com.")
        if not parsed.path.startswith("/a/"):
            raise ValueError("Скопируйте адрес приложения 1С:Фреш из адресной строки.")
        # Адрес, скопированный из браузера, обычно заканчивается языковым
        # сегментом /ru. OData публикуется на уровне самого приложения.
        path_parts = [part for part in parsed.path.split("/") if part]
        if path_parts and len(path_parts[-1]) == 2 and path_parts[-1].isalpha():
            path_parts.pop()
            url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/" + "/".join(path_parts), "", ""))
    elif kind == "local":
        if not is_private_host(hostname):
            raise ValueError("Для локальной базы укажите адрес в локальной сети.")
    else:
        raise ValueError("Неизвестный тип подключения.")
    suffix = "/odata/standard.odata"
    return url if url.endswith(suffix) else url + suffix


def inspect_metadata(xml_bytes: bytes, content_type: str = "", final_url: str = "") -> dict[str, object]:
    preview = xml_bytes.lstrip()[:240].lower()
    if preview.startswith(b"<!doctype html") or preview.startswith(b"<html"):
        raise ValueError(
            "1С вернула HTML-страницу вместо OData metadata. "
            "Адрес верный, но настройка автоматического REST-сервиса ещё не сохранена "
            "или введён пароль не от пользователя OData. "
            f"Тип ответа: {content_type or 'не указан'}; адрес ответа: {final_url or 'не указан'}."
        )
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as error:
        excerpt = " ".join(
            xml_bytes[:300].decode("utf-8", errors="replace").replace("\n", " ").split()
        )
        raise ValueError(
            "1С вернула некорректный XML вместо OData metadata. "
            f"Ответ начинается так: {excerpt or 'пустой ответ'}. "
            f"Тип ответа: {content_type or 'не указан'}; адрес ответа: {final_url or 'не указан'}."
        ) from error
    entity_sets = []
    for element in root.iter():
        if element.tag.endswith("EntitySet") and element.attrib.get("Name"):
            entity_sets.append(element.attrib["Name"])
    bank_documents = [
        name for name in entity_sets
        if name.startswith("Document_") and any(word in name.lower() for word in ("расчетн", "расчётн", "банк"))
    ]
    return {"entityCount": len(entity_sets), "bankDocuments": sorted(bank_documents)[:30]}


def odata_json(odata_url: str, token: str, entity: str, limit: int) -> list[dict[str, object]]:
    query = urllib.parse.urlencode({"$top": str(limit), "$orderby": "Date desc", "$format": "json"})
    resource = urllib.parse.quote(entity, safe="_")
    request = urllib.request.Request(
        f"{odata_url}/{resource}?{query}",
        headers={"Authorization": "Basic " + token, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20, context=ssl.create_default_context()) as response:
        payload = json.loads(response.read(8 * 1024 * 1024).decode("utf-8"))
    if isinstance(payload.get("d"), dict):
        return payload["d"].get("results", [])
    return payload.get("value", [])


def read_value(row: dict[str, object], *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return str(value)
    return ""


def bank_preview(odata_url: str, token: str, limit: int) -> list[dict[str, object]]:
    documents = [("Document_ПоступлениеНаРасчетныйСчет", "in"), ("Document_СписаниеСРасчетногоСчета", "out")]
    operations = []
    for entity, direction in documents:
        for row in odata_json(odata_url, token, entity, limit):
            if not isinstance(row, dict):
                continue
            operations.append({
                "direction": direction,
                "date": read_value(row, "Date", "Дата"),
                "number": read_value(row, "Number", "Номер"),
                "amount": read_value(row, "Amount", "СуммаДокумента", "Сумма"),
                "counterparty": read_value(row, "Контрагент", "КонтрагентПредставление", "Контрагент_Name"),
                "purpose": read_value(row, "НазначениеПлатежа", "Комментарий", "Содержание"),
            })
    return operations[:limit]


def parse_odata_date(value: str) -> str:
    import re
    match = re.search(r"/Date\((-?\d+)", value)
    if match:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(int(match.group(1)) / 1000, timezone.utc).date().isoformat()
    return value[:10]


def normalize_amount(value: str) -> int | None:
    try:
        return round(float(value.replace(",", ".")) * 100)
    except ValueError:
        return None


def reconcile_bank_operations(operations: list[dict[str, object]]) -> list[dict[str, object]]:
    if not ACTIVE_CONNECTION:
        raise ValueError("Сначала подтвердите подключение к 1С на странице «Подключения».")
    documents = []
    for entity, direction in [("Document_ПоступлениеНаРасчетныйСчет", "in"), ("Document_СписаниеСРасчетногоСчета", "out")]:
        for row in odata_json(ACTIVE_CONNECTION["odataUrl"], ACTIVE_CONNECTION["token"], entity, 300):
            if isinstance(row, dict):
                amount = normalize_amount(read_value(row, "Amount", "СуммаДокумента", "Сумма"))
                date = parse_odata_date(read_value(row, "Date", "Дата"))
                if amount is not None and len(date) == 10:
                    documents.append({"direction": direction, "date": date, "kopecks": amount, "number": read_value(row, "Number", "Номер")})
    result = []
    for operation in operations[:500]:
        date = str(operation.get("date", ""))
        direction = str(operation.get("direction", ""))
        kopecks = operation.get("kopecks")
        match = next((document for document in documents if document["date"] == date and document["direction"] == direction and document["kopecks"] == kopecks), None)
        result.append({"reference": operation.get("reference", ""), "state": "matched" if match else "missing", "documentNumber": match["number"] if match else ""})
    return result


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
        if self.path not in {"/api/1c/test", "/api/1c/bank-preview", "/api/1c/reconcile"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Маршрут не найден."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("Некорректный размер запроса.")
            payload = json.loads(self.rfile.read(length))
            if self.path == "/api/1c/reconcile":
                rows = payload.get("operations", [])
                if not isinstance(rows, list):
                    raise ValueError("Некорректные данные операций для сверки.")
                self.send_json(HTTPStatus.OK, {"ok": True, "results": reconcile_bank_operations(rows)})
                return
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
                # В типовой Бухгалтерии metadata может содержать тысячи
                # объектов и быть больше 4 МБ. Не обрезаем корректный XML.
                metadata = response.read(MAX_METADATA)
                content_type = response.headers.get_content_type()
                final_url = response.geturl()
            result = inspect_metadata(metadata, content_type, final_url)
            result.update({"ok": True, "odataUrl": odata_url})
            ACTIVE_CONNECTION.update({"odataUrl": odata_url, "token": token})
            if self.path == "/api/1c/bank-preview":
                result["operations"] = bank_preview(odata_url, token, min(max(int(payload.get("limit", 10)), 1), 10))
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
            print(f"OData check rejected: {error}", flush=True)
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Не удалось проверить подключение."})


if __name__ == "__main__":
    port = int(os.environ.get("OPORA_PORT", "8787"))
    print(f"ОПОРА Бухгалтерия: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
