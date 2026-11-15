"""Text normalization shared by grading, search and quote checks."""

from __future__ import annotations

import html
import re
import string
import unicodedata

_PUNCT = str.maketrans("", "", string.punctuation + "。，、；：？！“”‘’（）《》【】　")
_TAG = re.compile(r"<[^>]+>")
_BLOCK = re.compile(r"</?(p|br|div|li|tr)\b[^>]*>", re.I)
_MATH_DELIM = re.compile(r"\\[()\[\]]")


def html_to_text(value: str) -> str:
    """Readable plain text: tags dropped, entities decoded, LaTeX delimiters removed."""
    text = _BLOCK.sub(" ", value or "")
    text = _MATH_DELIM.sub("", _TAG.sub("", text))
    return " ".join(html.unescape(text).split())


def normalize_space(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def normalize_answer(text: str) -> str:
    plain = unicodedata.normalize("NFKC", html_to_text(text))
    return plain.casefold().translate(_PUNCT).replace(" ", "")


def contains_quote(haystack: str, quote: str) -> bool:
    """Whether ``quote`` literally appears in ``haystack``, ignoring whitespace layout.

    The pattern from DeepTutor ``lesson_evidence.py``: the model or bank names
    a quote, the server checks it really is in the source.
    """
    needle = normalize_space(quote)
    return bool(needle) and needle in normalize_space(haystack)
