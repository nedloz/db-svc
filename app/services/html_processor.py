# Конвертер HTML → чистый Markdown для RAG.
# Выкидывает «мусорные» теги (навигация, подвалы, скрипты и т.п.) и переводит
# оставшийся HTML в Markdown, сохраняя заголовки/списки/таблицы/ссылки.
#
# Используется в импорте HTML (minio_import_placeholder.py): рядом с сырым .html
# в MinIO кладётся .txt-версия для чанкинга/эмбеддингов.

import re

import html2text
from bs4 import BeautifulSoup


def clean_html_for_rag(html_content: bytes, encoding: str = 'utf-8') -> str:
    soup = BeautifulSoup(html_content, 'html.parser', from_encoding=encoding)
    for element in soup(["script", "style", "nav", "footer", "header", "aside", "form", "noscript"]):
        element.decompose()
    h = html2text.HTML2Text()
    h.ignore_links = False
    h.ignore_images = True
    h.body_width = 0
    h.strong_mark = "__"
    markdown_text = h.handle(str(soup))
    markdown_text = re.sub(r'\n{3,}', '\n\n', markdown_text)
    return markdown_text.strip()
