#!/usr/bin/env python3
"""Apply Anthropic streaming safety fixes to pinned LiteLLM v1.93.0."""

from __future__ import annotations

import json
import py_compile
import re
import site
import sys
from pathlib import Path
from typing import Any


MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/adapters/streaming_iterator.py"
)
RESPONSES_MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/responses_adapters/streaming_iterator.py"
)
RESPONSES_MAIN_MODULE_PATH = Path("litellm/responses/main.py")
RESPONSES_STREAMING_ITERATOR_MODULE_PATH = Path(
    "litellm/responses/streaming_iterator.py"
)
ANTHROPIC_ADAPTER_MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py"
)
ANTHROPIC_RESPONSES_TRANSFORMATION_MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/responses_adapters/transformation.py"
)
TOKEN_COUNTER_MODULE_PATH = Path("litellm/litellm_core_utils/token_counter.py")
PROXY_SERVER_MODULE_PATH = Path("litellm/proxy/proxy_server.py")
ANTHROPIC_ENDPOINTS_MODULE_PATH = Path("litellm/proxy/anthropic_endpoints/endpoints.py")

STANDARD_IMPORT_ANCHOR = "import copy\nimport json\nimport traceback\n"
PATCHED_STANDARD_IMPORTS = (
    "import asyncio\n"
    "import contextlib\n"
    "import copy\n"
    "import json\n"
    "import os\n"
    "import re\n"
    "import traceback\n"
)

IMPORT_ANCHOR = "from litellm._uuid import uuid\n"
PATCHED_IMPORTS = (
    "from litellm._uuid import uuid\n"
    "from litellm.exceptions import MidStreamFallbackError\n"
    "from litellm.llms.base_llm.chat.transformation import BaseLLMException\n"
)


# This source fragment is injected into both Anthropic streaming adapters.
# Keep the traversal bounded: exception objects can contain cyclic references
# and provider response bodies can be unexpectedly large.
ANTHROPIC_ERROR_HELPERS = r'''


_CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH = 8
_CHAT2API_ANTHROPIC_ERROR_MAX_NODES = 128
_CHAT2API_ANTHROPIC_ERROR_MAX_TEXT = 4096
_CHAT2API_ANTHROPIC_ERROR_CHILD_FIELDS = (
    "original_exception",
    "__cause__",
    "__context__",
    "error",
    "errors",
    "detail",
    "details",
    "body",
    "data",
    "response",
)
_CHAT2API_ANTHROPIC_ERROR_STATUS_FIELDS = (
    "status",
    "status_code",
    "http_status",
    "httpStatus",
)
_CHAT2API_ANTHROPIC_ERROR_CODE_FIELDS = (
    "code",
    "error_code",
    "errorCode",
)
_CHAT2API_ANTHROPIC_ERROR_MESSAGE_FIELDS = (
    "message",
    "detail",
    "error_description",
)
_CHAT2API_ANTHROPIC_ERROR_TYPE_FIELDS = (
    "type",
    "error_type",
    "errorType",
)
_CHAT2API_ANTHROPIC_TRANSPORT_CODE_RE = re.compile(
    r"\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|HOSTUNREACH|NETWORKUNREACH|AI_AGAIN|ADDRINUSE)\b"
)


def _chat2api_anthropic_error_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()[:_CHAT2API_ANTHROPIC_ERROR_MAX_TEXT]
    if value is None or isinstance(value, (bytes, bytearray)):
        return ""
    try:
        return str(value).strip()[:_CHAT2API_ANTHROPIC_ERROR_MAX_TEXT]
    except Exception:
        return ""


def _chat2api_anthropic_error_field(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    try:
        return getattr(value, name, None)
    except Exception:
        return None


def _chat2api_anthropic_error_children(value: Any) -> list[Any]:
    children: list[Any] = []
    if isinstance(value, dict):
        for name in _CHAT2API_ANTHROPIC_ERROR_CHILD_FIELDS:
            if name in value and value[name] is not None:
                children.append(value[name])
        return children

    for name in _CHAT2API_ANTHROPIC_ERROR_CHILD_FIELDS:
        child = _chat2api_anthropic_error_field(value, name)
        if child is not None:
            children.append(child)

    # Some SDK response objects expose the structured payload only through
    # json(). Reading it is best effort and remains bounded by the graph walk.
    json_method = _chat2api_anthropic_error_field(value, "json")
    if callable(json_method):
        try:
            parsed = json_method()
        except Exception:
            parsed = None
        if parsed is not None:
            children.append(parsed)
    return children


def _chat2api_anthropic_error_nodes(root: Any) -> list[tuple[int, Any]]:
    queue: list[tuple[int, Any]] = [(0, root)]
    nodes: list[tuple[int, Any]] = []
    seen: set[int] = set()
    while queue and len(nodes) < _CHAT2API_ANTHROPIC_ERROR_MAX_NODES:
        depth, value = queue.pop(0)
        if value is None or depth > _CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH:
            continue
        if isinstance(value, (dict, list, tuple, set)) or hasattr(value, "__dict__"):
            identity = id(value)
            if identity in seen:
                continue
            seen.add(identity)
        nodes.append((depth, value))

        if isinstance(value, (list, tuple, set)):
            queue.extend((depth + 1, child) for child in value)
        else:
            queue.extend((depth + 1, child) for child in _chat2api_anthropic_error_children(value))

        args = _chat2api_anthropic_error_field(value, "args")
        if isinstance(args, (list, tuple)):
            queue.extend((depth + 1, child) for child in args[:8])

        text = _chat2api_anthropic_error_text(value)
        if text.startswith("{") and text.endswith("}"):
            try:
                queue.append((depth + 1, json.loads(text)))
            except Exception:
                pass
    return nodes


def _chat2api_anthropic_error_number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if 400 <= number <= 599 else None


def _chat2api_anthropic_error_details(value: Any, fallback_message: str = "") -> dict[str, Any]:
    """Extract bounded, provider-neutral details from an exception graph."""
    nodes = _chat2api_anthropic_error_nodes(value)
    status_candidates: list[tuple[int, int]] = []
    code_candidates: list[tuple[int, str]] = []
    type_candidates: list[tuple[int, str]] = []
    message_candidates: list[tuple[int, str]] = []

    for depth, node in nodes:
        for field in _CHAT2API_ANTHROPIC_ERROR_STATUS_FIELDS:
            status = _chat2api_anthropic_error_number(_chat2api_anthropic_error_field(node, field))
            if status is not None:
                status_candidates.append((depth, status))
        for field in _CHAT2API_ANTHROPIC_ERROR_CODE_FIELDS:
            candidate = _chat2api_anthropic_error_text(_chat2api_anthropic_error_field(node, field))
            if candidate and not candidate.isdigit():
                code_candidates.append((depth, candidate))
        for field in _CHAT2API_ANTHROPIC_ERROR_TYPE_FIELDS:
            candidate = _chat2api_anthropic_error_text(_chat2api_anthropic_error_field(node, field))
            if candidate and candidate.lower() != "error":
                type_candidates.append((depth, candidate))
        for field in _CHAT2API_ANTHROPIC_ERROR_MESSAGE_FIELDS:
            candidate = _chat2api_anthropic_error_text(_chat2api_anthropic_error_field(node, field))
            if candidate:
                message_candidates.append((depth, candidate))

        # Bare SDK/transport exceptions often only carry text in __str__ and
        # args, without a ``message`` attribute. Include that text so a nested
        # original_exception remains visible after LiteLLM wraps it.
        if not isinstance(node, (dict, list, tuple, set)) and depth > 0:
            node_text = _chat2api_anthropic_error_text(node)
            if node_text:
                message_candidates.append((depth, node_text))

        transport_match = _CHAT2API_ANTHROPIC_TRANSPORT_CODE_RE.search(
            _chat2api_anthropic_error_text(node)
        )
        if transport_match:
            code_candidates.append((depth, transport_match.group(0)))

    # LiteLLM's MidStreamFallbackError defaults to 503 when its wrapped
    # transport exception has no HTTP status. Prefer a nested real status.
    status = None
    for _, candidate in sorted(status_candidates, key=lambda item: item[0]):
        if candidate != 503:
            status = candidate
            break
    if status is None and status_candidates:
        status = status_candidates[0][1]

    code = code_candidates[-1][1] if code_candidates else None
    upstream_type = type_candidates[-1][1] if type_candidates else None
    # The nested/original exception is queued after the wrapper, so the last
    # candidate is the provider's most specific message.
    message = message_candidates[-1][1] if message_candidates else ""
    if not message:
        message = _chat2api_anthropic_error_text(fallback_message)
    if not message:
        message = "Upstream stream ended before completion"

    probe = " ".join([message, code or ""]).lower()
    # A default 503 on MidStreamFallbackError means "no status propagated";
    # transport-specific evidence is more useful for clients and diagnostics.
    if status is None or status == 503:
        if "timeout" in probe or "timed out" in probe:
            status = 504
        elif _CHAT2API_ANTHROPIC_TRANSPORT_CODE_RE.search(message) or any(
            term in probe for term in ("connection", "transport", "socket", "premature eof")
        ):
            status = 502

    return {
        "status": status,
        "code": code,
        "message": message[:_CHAT2API_ANTHROPIC_ERROR_MAX_TEXT],
        "upstream_type": upstream_type,
    }


def _chat2api_anthropic_error_response(value: Any, fallback_message: str = "") -> dict[str, Any]:
    from litellm.anthropic_interface.exceptions.exception_mapping_utils import (
        AnthropicExceptionMapping,
    )

    details = _chat2api_anthropic_error_details(value, fallback_message)
    status = details["status"] if details["status"] is not None else 500
    response = AnthropicExceptionMapping.transform_to_anthropic_error(
        status_code=status,
        raw_message=details["message"],
    )
    error = response.get("error")
    if isinstance(error, dict):
        if details["status"] is not None:
            error["status"] = details["status"]
        if details["code"]:
            error["code"] = details["code"]
        if details["upstream_type"]:
            error["upstream_type"] = details["upstream_type"]
    return response


'''


# The same fragment is exposed in the patcher namespace for offline tests.
exec(ANTHROPIC_ERROR_HELPERS, globals())

HELPER_ANCHOR = """if TYPE_CHECKING:
    from litellm.types.utils import ModelResponseStream


class _CombinedChunkSplitter:
"""
PATCHED_HELPERS = '''if TYPE_CHECKING:
    from litellm.types.utils import ModelResponseStream

''' + ANTHROPIC_ERROR_HELPERS + '''


DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS = 15_000


def _anthropic_sse_heartbeat_interval_seconds() -> float:
    raw = os.environ.get("LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS")
    if raw is None or not raw.strip():
        return DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS / 1000
    try:
        value = int(raw)
    except ValueError:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    if value < 0:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    return value / 1000


def _anthropic_sse_ping_event() -> bytes:
    return b'event: ping\\ndata: {"type":"ping"}\\n\\n'


def _error_status_and_message(exc: Exception) -> tuple[int, str]:
    details = _chat2api_anthropic_error_details(
        exc,
        _chat2api_anthropic_error_text(getattr(exc, "message", "")),
    )
    return details["status"] or 500, details["message"]


def _mid_stream_error_sse_event(exc: Exception) -> bytes:
    error_response = _chat2api_anthropic_error_response(
        exc,
        _chat2api_anthropic_error_text(getattr(exc, "message", "")),
    )
    return f"event: error\\ndata: {json.dumps(error_response)}\\n\\n".encode()


class _CombinedChunkSplitter:
'''

ORIGINAL_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """
        Async version of anthropic_sse_wrapper.
        Convert AnthropicStreamWrapper dict chunks to Server-Sent Events format.
        """
        async for chunk in self:
            if isinstance(chunk, dict):
                event_type: str = str(chunk.get("type", "message"))
                payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                yield payload.encode()
            else:
                # For non-dict chunks, forward the original value unchanged
                yield chunk
'''

PATCHED_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """
        Async version of anthropic_sse_wrapper.
        Convert AnthropicStreamWrapper dict chunks to Server-Sent Events format.
        """
        heartbeat_interval = _anthropic_sse_heartbeat_interval_seconds()
        pending_chunk: Optional[asyncio.Task[Any]] = None
        try:
            while True:
                if pending_chunk is None:
                    pending_chunk = asyncio.create_task(self.__anext__())

                if heartbeat_interval > 0:
                    done, _ = await asyncio.wait(
                        {pending_chunk},
                        timeout=heartbeat_interval,
                    )
                    if not done:
                        yield _anthropic_sse_ping_event()
                        continue

                try:
                    chunk = await pending_chunk
                except StopAsyncIteration:
                    pending_chunk = None
                    break
                pending_chunk = None

                if isinstance(chunk, dict):
                    event_type: str = str(chunk.get("type", "message"))
                    payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                    yield payload.encode()
                else:
                    yield chunk
        except Exception as exc:  # noqa: BLE001
            verbose_logger.exception(
                "Anthropic Adapter - mid-stream error, emitting Anthropic error event: %s",
                exc,
            )
            yield _mid_stream_error_sse_event(exc)
        finally:
            if pending_chunk is not None:
                if not pending_chunk.done():
                    pending_chunk.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await pending_chunk
'''

RESPONSES_IMPORT_ANCHOR = '''import json
import traceback
from collections import deque
from typing import Any, AsyncIterator, Dict

from litellm import verbose_logger
from litellm._uuid import uuid
'''

RESPONSES_PATCHED_IMPORTS = '''import asyncio
import contextlib
import json
import os
import re
import traceback
from collections import deque
from typing import Any, AsyncIterator, Dict

from litellm import verbose_logger
from litellm._uuid import uuid
'''

RESPONSES_HELPER_ANCHOR = '''from litellm._uuid import uuid


class AnthropicResponsesStreamWrapper:'''

RESPONSES_PATCHED_HELPERS = '''from litellm._uuid import uuid
''' + ANTHROPIC_ERROR_HELPERS + '''


DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS = 15_000


def _anthropic_sse_heartbeat_interval_seconds() -> float:
    raw = os.environ.get("LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS")
    if raw is None or not raw.strip():
        return DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS / 1000
    try:
        value = int(raw)
    except ValueError:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    if value < 0:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    return value / 1000


def _anthropic_sse_ping_event() -> bytes:
    return b'event: ping\\ndata: {"type":"ping"}\\n\\n'


def _anthropic_responses_error_event(error: Any, fallback_message: str = "") -> Dict[str, Any]:
    return {
        **_chat2api_anthropic_error_response(error, fallback_message),
    }


class AnthropicResponsesStreamWrapper:'''

# Import blocks emitted by the previous overlay revision. They are kept
# separate from the clean-image anchors so upgrades can be validated exactly.
LEGACY_STANDARD_IMPORTS = (
    "import asyncio\n"
    "import contextlib\n"
    "import copy\n"
    "import json\n"
    "import os\n"
    "import traceback\n"
)
LEGACY_RESPONSES_IMPORTS = '''import asyncio
import contextlib
import json
import os
import traceback
from collections import deque
from typing import Any, AsyncIterator, Dict

from litellm import verbose_logger
from litellm._uuid import uuid
'''

RESPONSES_STATE_ANCHOR = '''        self._sent_message_start = False
        self._sent_message_stop = False
        self._chunk_queue: deque = deque()
'''

RESPONSES_STATE_PATCH = '''        self._sent_message_start = False
        self._sent_message_stop = False
        self._terminal_error_seen = False
        self._chunk_queue: deque = deque()
'''

RESPONSES_PROCESS_EVENT_ANCHOR = '''    def _process_event(self, event: Any) -> None:
        """Convert one Responses API event into zero or more Anthropic chunks queued for emission."""
'''

RESPONSES_PROCESS_EVENT_PATCH = '''    @staticmethod
    def _event_field(value: Any, name: str) -> Any:
        if isinstance(value, dict):
            return value.get(name)
        return getattr(value, name, None)

    @classmethod
    def _event_error_message(cls, event: Any) -> str:
        direct_message = cls._event_field(event, "message")
        if isinstance(direct_message, str) and direct_message:
            return direct_message

        response = cls._event_field(event, "response")
        error = cls._event_field(response, "error") if response is not None else None
        if isinstance(error, str) and error:
            return error
        nested_message = cls._event_field(error, "message") if error is not None else None
        if isinstance(nested_message, str) and nested_message:
            return nested_message
        return "Upstream Responses stream failed before completion"

    def _queue_terminal_error(self, error: Any, fallback_message: str = "") -> None:
        if self._terminal_error_seen or self._sent_message_stop:
            return
        self._terminal_error_seen = True
        self._sent_message_stop = True
        self._chunk_queue.append(_anthropic_responses_error_event(error, fallback_message))

    def _process_event(self, event: Any) -> None:
        """Convert one Responses API event into zero or more Anthropic chunks queued for emission."""
'''

RESPONSES_CREATED_ANCHOR = '''        if event_type == "response.created":
            self._sent_message_start = True
            self._chunk_queue.append(self._make_message_start())
            return
'''

RESPONSES_CREATED_PATCH = '''        if event_type == "response.created":
            if not self._sent_message_start:
                self._sent_message_start = True
                self._chunk_queue.append(self._make_message_start())
            return
'''

RESPONSES_OUTPUT_ITEM_ANCHOR = '''        # ---- content_block_start for a new output message item ----
        if event_type == "response.output_item.added":
'''

RESPONSES_OUTPUT_ITEM_PATCH = '''        # ---- terminal Responses error ----
        if event_type == "error":
            self._queue_terminal_error(event, self._event_error_message(event))
            return

        # ---- content_block_start for a new output message item ----
        if event_type == "response.output_item.added":
'''

RESPONSES_TERMINAL_ANCHOR = '''        # ---- response completed -> message_delta + message_stop ----
        if event_type in (
            "response.completed",
            "response.failed",
            "response.incomplete",
        ):
'''

RESPONSES_TERMINAL_PATCH = '''        # ---- failed response -> terminal Anthropic error ----
        if event_type == "response.failed":
            self._queue_terminal_error(event, self._event_error_message(event))
            return

        # ---- response completed -> message_delta + message_stop ----
        if event_type in (
            "response.completed",
            "response.incomplete",
        ):
'''

RESPONSES_ANEXT_ANCHOR = '''    async def __anext__(self) -> Dict[str, Any]:
        # Return any queued chunks first
        if self._chunk_queue:
            return self._chunk_queue.popleft()

        # Emit message_start if not yet done (fallback if response.created wasn't fired)
        if not self._sent_message_start:
            self._sent_message_start = True
            self._chunk_queue.append(self._make_message_start())
            return self._chunk_queue.popleft()

        # Consume the upstream stream
        try:
            async for event in self.responses_stream:
                self._process_event(event)
                if self._chunk_queue:
                    return self._chunk_queue.popleft()
        except StopAsyncIteration:
            pass
        except Exception as e:
            verbose_logger.error(f"AnthropicResponsesStreamWrapper error: {e}\\n{traceback.format_exc()}")

        # Drain any remaining queued chunks
        if self._chunk_queue:
            return self._chunk_queue.popleft()

        raise StopAsyncIteration
'''

RESPONSES_ANEXT_PATCH = '''    async def __anext__(self) -> Dict[str, Any]:
        # Return any queued chunks first
        if self._chunk_queue:
            return self._chunk_queue.popleft()
        if self._terminal_error_seen:
            raise StopAsyncIteration

        # Emit message_start if not yet done (fallback if response.created wasn't fired)
        if not self._sent_message_start:
            self._sent_message_start = True
            self._chunk_queue.append(self._make_message_start())
            return self._chunk_queue.popleft()

        # Consume the upstream stream
        try:
            async for event in self.responses_stream:
                self._process_event(event)
                if self._chunk_queue:
                    return self._chunk_queue.popleft()
        except StopAsyncIteration:
            pass
        except Exception as exc:
            verbose_logger.error(
                f"AnthropicResponsesStreamWrapper error: {exc}\\n{traceback.format_exc()}"
            )
            self._queue_terminal_error(exc, str(exc) or "Upstream Responses transport failed")

        # A clean EOF without a Responses terminal event is still a broken stream.
        if not self._sent_message_stop and not self._terminal_error_seen:
            self._queue_terminal_error(
                None,
                "Upstream Responses stream ended before response.completed",
            )
        if self._chunk_queue:
            return self._chunk_queue.popleft()

        raise StopAsyncIteration
'''

RESPONSES_ORIGINAL_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """Yield SSE-encoded bytes for each Anthropic event chunk."""
        async for chunk in self:
            if isinstance(chunk, dict):
                event_type: str = str(chunk.get("type", "message"))
                payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                yield payload.encode()
            else:
                yield chunk
'''

RESPONSES_PATCHED_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """Yield observable SSE and terminate failed Responses streams explicitly."""
        heartbeat_interval = _anthropic_sse_heartbeat_interval_seconds()
        pending_chunk = None
        try:
            while True:
                if pending_chunk is None:
                    pending_chunk = asyncio.create_task(self.__anext__())

                if heartbeat_interval > 0:
                    done, _ = await asyncio.wait(
                        {pending_chunk},
                        timeout=heartbeat_interval,
                    )
                    if not done:
                        yield _anthropic_sse_ping_event()
                        continue

                try:
                    chunk = await pending_chunk
                except StopAsyncIteration:
                    pending_chunk = None
                    break
                pending_chunk = None

                if isinstance(chunk, dict):
                    event_type: str = str(chunk.get("type", "message"))
                    payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                    yield payload.encode()
                else:
                    yield chunk
        except Exception as exc:  # noqa: BLE001
            verbose_logger.exception(
                "Anthropic Responses adapter failed while emitting SSE: %s",
                exc,
            )
            if not self._terminal_error_seen and not self._sent_message_stop:
                payload = _anthropic_responses_error_event(
                    exc,
                    str(exc) or "Upstream Responses transport failed",
                )
                yield f"event: error\\ndata: {json.dumps(payload)}\\n\\n".encode()
        finally:
            if pending_chunk is not None:
                if not pending_chunk.done():
                    pending_chunk.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await pending_chunk
'''

RESPONSES_NATIVE_STREAM_MARKER = "Chat2API wildcard declares native Responses streaming"
RESPONSES_NATIVE_STREAM_ANCHOR = '''            fake_stream=responses_api_provider_config.should_fake_stream(
                model=model, stream=stream, custom_llm_provider=custom_llm_provider
            ),
'''
RESPONSES_NATIVE_STREAM_PATCH = '''            # Chat2API wildcard declares native Responses streaming through
            # model_info because the internal model id "*" is absent from
            # LiteLLM's capability catalog.
            fake_stream=(
                False
                if isinstance(kwargs.get("model_info"), dict)
                and kwargs["model_info"].get("supports_native_streaming") is True
                else responses_api_provider_config.should_fake_stream(
                    model=model,
                    stream=stream,
                    custom_llm_provider=custom_llm_provider,
                )
            ),
'''


# LiteLLM's generic Responses iterator turns terminal ``error`` and
# ``response.failed`` events into exceptions before the Anthropic adapter can
# inspect them.  Keep the extraction provider-neutral and accept both the
# OpenAI-shaped nested error object and Chat2API's top-level error fields.
RESPONSES_ITERATOR_ERROR_DETAILS_MARKER = (
    "_CHAT2API_RESPONSES_ITERATOR_ERROR_DETAILS"
)
RESPONSES_ITERATOR_ERROR_HELPERS = r'''_CHAT2API_RESPONSES_ITERATOR_ERROR_DETAILS = True


_CHAT2API_RESPONSES_ERROR_STATUS_FIELDS = (
    "status",
    "status_code",
    "http_status",
    "httpStatus",
)
_CHAT2API_RESPONSES_ERROR_CODE_FIELDS = (
    "code",
    "error_code",
    "errorCode",
)
_CHAT2API_RESPONSES_ERROR_TYPE_FIELDS = (
    "type",
    "error_type",
    "errorType",
)
_CHAT2API_RESPONSES_ERROR_MESSAGE_FIELDS = (
    "message",
    "detail",
    "error_description",
)


def _chat2api_responses_error_field(value: object, name: str) -> object:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(name)
    getter = getattr(value, "get", None)
    if callable(getter):
        try:
            result = getter(name, None)
        except Exception:
            result = None
        if result is not None:
            return result
    try:
        return getattr(value, name, None)
    except Exception:
        return None


def _chat2api_responses_error_status(value: object) -> Optional[int]:
    for field in _CHAT2API_RESPONSES_ERROR_STATUS_FIELDS:
        raw = _chat2api_responses_error_field(value, field)
        if isinstance(raw, bool):
            continue
        try:
            status = int(raw)
        except (TypeError, ValueError, OverflowError):
            continue
        if 400 <= status <= 599:
            return status
    return None


def _chat2api_responses_error_text(value: object) -> Optional[str]:
    if isinstance(value, str):
        text = value.strip()
        return text if text else None
    return None


def _error_event_fields(
    error_obj: object,
    fallback_obj: object = None,
) -> tuple[str, Optional[str], Optional[str], Optional[int]]:
    """Read structured error fields without discarding event-level metadata."""
    candidates = (error_obj, fallback_obj)

    def first_text(fields: tuple[str, ...]) -> Optional[str]:
        for candidate in candidates:
            for field in fields:
                text = _chat2api_responses_error_text(
                    _chat2api_responses_error_field(candidate, field)
                )
                if text:
                    return text
        return None

    status: Optional[int] = None
    for candidate in candidates:
        status = _chat2api_responses_error_status(candidate)
        if status is not None:
            break

    message = first_text(_CHAT2API_RESPONSES_ERROR_MESSAGE_FIELDS)
    error_type = first_text(_CHAT2API_RESPONSES_ERROR_TYPE_FIELDS)
    if error_type in {"error", "response.failed"}:
        error_type = None
    error_code = first_text(_CHAT2API_RESPONSES_ERROR_CODE_FIELDS)
    return (
        message or "Response API in-stream error",
        error_type,
        error_code,
        status,
    )


def _status_code_for_error_fields(
    error_type: Optional[str],
    error_code: Optional[str],
    explicit_status: Optional[int] = None,
) -> int:
    if explicit_status is not None and 400 <= explicit_status <= 599:
        return explicit_status
    fields = tuple(field for field in (error_type, error_code) if field is not None)
    if any(field.startswith("rate_limit") or field == "insufficient_quota" for field in fields):
        return 429
    if any(field in _CLIENT_ERROR_CODES for field in fields):
        return 400
    return 500


def _annotate_error_exception(
    exception: Exception,
    error_type: Optional[str],
    error_code: Optional[str],
    status_code: int,
) -> Exception:
    """Make structured fields available to LiteLLM fallback/error mappers."""
    if error_code:
        setattr(exception, "code", error_code)
        setattr(exception, "error_code", error_code)
    if error_type:
        setattr(exception, "type", error_type)
        setattr(exception, "error_type", error_type)
    setattr(exception, "status", status_code)
    setattr(exception, "status_code", status_code)
    return exception
'''

RESPONSES_ITERATOR_ERROR_HELPERS_ANCHOR = '''_CLIENT_ERROR_CODES: frozenset[str] = frozenset(
    (
        "invalid_request_error",
        "context_length_exceeded",
        "content_policy_violation",
        "model_not_found",
    )
)


def _error_event_fields(error_obj: object) -> tuple[str, Optional[str], Optional[str]]:
    if isinstance(error_obj, dict):
        raw_message = error_obj.get("message")
        raw_type = error_obj.get("type")
        raw_code = error_obj.get("code")
    elif error_obj is not None:
        raw_message = getattr(error_obj, "message", None)
        raw_type = getattr(error_obj, "type", None)
        raw_code = getattr(error_obj, "code", None)
    else:
        raw_message = None
        raw_type = None
        raw_code = None
    message = str(raw_message) if raw_message is not None else "Response API in-stream error"
    error_type = raw_type if isinstance(raw_type, str) else None
    code = raw_code if isinstance(raw_code, str) else None
    return message, error_type, code


def _status_code_for_error_fields(error_type: Optional[str], error_code: Optional[str]) -> int:
    fields = tuple(field for field in (error_type, error_code) if field is not None)
    if any(field.startswith("rate_limit") or field == "insufficient_quota" for field in fields):
        return 429
    if any(field in _CLIENT_ERROR_CODES for field in fields):
        return 400
    return 500
'''

RESPONSES_ITERATOR_FAILURE_HANDLERS = '''    def _handle_logging_failed_response(self):
        """
        Handle logging for RESPONSE_FAILED events by routing to failure handlers.

        Unlike _handle_logging_completed_response (which calls success handlers),
        this constructs an exception from the response error and routes to
        async_failure_handler / failure_handler so logging integrations correctly
        record the call as failed.
        """
        response_obj = getattr(self.completed_response, "response", None) if self.completed_response else None
        error_info = getattr(response_obj, "error", None) if response_obj else None
        error_message, error_type, error_code, explicit_status = _error_event_fields(
            error_info,
            self.completed_response,
        )
        self._record_failed_response_usage(response_obj)
        status_code = _status_code_for_error_fields(
            error_type,
            error_code,
            explicit_status,
        )
        exception = litellm.APIError(
            status_code=status_code,
            message=error_message,
            llm_provider=self.custom_llm_provider or "",
            model=self.model or "",
        )
        self._handle_failure(
            _annotate_error_exception(exception, error_type, error_code, status_code)
        )

    def _record_failed_response_usage(self, response_obj: Optional[Any]) -> None:
        if response_obj is None or self.logging_obj is None:
            return
        usage_obj = getattr(response_obj, "usage", None)
        if usage_obj is None:
            return
        try:
            self.logging_obj.model_call_details["combined_usage_object"] = (
                ResponseAPILoggingUtils._transform_response_api_usage_to_chat_usage(usage_obj)
            )
        except (TypeError, ValueError) as usage_error:
            verbose_logger.debug(
                "could not record usage for failed responses stream: %s",
                usage_error,
            )
            return
        self.logging_obj.model_call_details["response_cost"] = (
            self.logging_obj._response_cost_calculator(result=response_obj) or 0.0
        )

    def _maybe_raise_for_error_event(self, result: object) -> None:
        chunk_type = getattr(result, "type", None)
        if chunk_type not in ("error", "response.failed"):
            return

        response_obj = _chat2api_responses_error_field(result, "response")
        error_obj = (
            _chat2api_responses_error_field(response_obj, "error")
            if chunk_type == "response.failed"
            else _chat2api_responses_error_field(result, "error")
        )
        error_message, error_type, error_code, explicit_status = _error_event_fields(
            error_obj,
            result,
        )
        status_code = _status_code_for_error_fields(
            error_type,
            error_code,
            explicit_status,
        )
        mapped_exception = litellm.APIError(
            status_code=status_code,
            message=error_message,
            llm_provider=self.custom_llm_provider or "",
            model=self.model or "",
        )
        mapped_exception = _annotate_error_exception(
            mapped_exception,
            error_type,
            error_code,
            status_code,
        )
        if 400 <= status_code < 500 and status_code != 429:
            raise mapped_exception
        fallback_exception = MidStreamFallbackError(
            message=str(mapped_exception),
            model=self.model or "",
            llm_provider=self.custom_llm_provider or "",
            original_exception=mapped_exception,
            generated_content=self._generated_content,
            is_pre_first_chunk=not self._yielded_first_chunk,
        )
        raise _annotate_error_exception(
            fallback_exception,
            error_type,
            error_code,
            status_code,
        )

'''

TOKEN_COUNTER_MARKER = "def _chat2api_anthropic_image_url("
TOKEN_COUNTER_HELPER_ANCHOR = "def _count_content_list(\n"
TOKEN_COUNTER_PATCHED_HELPERS = '''def _chat2api_anthropic_image_url(source: Any) -> dict[str, Any]:
    """Convert an Anthropic image source to LiteLLM's image_url shape."""
    if not isinstance(source, dict):
        raise ValueError("Anthropic image source must be an object")

    source_type = source.get("type")
    if source_type == "base64":
        data = source.get("data")
        if not isinstance(data, str) or not data:
            raise ValueError("Anthropic base64 image source requires data")
        # The pinned LiteLLM counter uses the default image cost for auto
        # detail and does not inspect this value. Avoid duplicating a large
        # base64 payload only to obtain that fixed cost.
        url = "anthropic-base64:opaque"
    elif source_type == "url":
        url = source.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError("Anthropic URL image source requires url")
        url = "anthropic-url:opaque"
    elif source_type == "file":
        file_id = source.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("Anthropic file image source requires file_id")
        url = "anthropic-file:opaque"
    else:
        reference = source.get("url") or source.get("file_id") or source.get("id") or source.get("data")
        if not isinstance(source_type, str) or not source_type or not isinstance(reference, str) or not reference:
            raise ValueError(f"Unsupported Anthropic image source type: {source_type}")
        # Future reference-backed image source types still receive the normal
        # image cost without sending their opaque value to the tokenizer.
        url = "anthropic-reference:opaque"

    return {"url": url, "detail": "auto"}


_CHAT2API_ANTHROPIC_MAX_CONTENT_DEPTH = 64
_CHAT2API_ANTHROPIC_MAX_CONTENT_NODES = 20_000
_CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS = 32 * 1024
_CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS = 4 * 1024
_CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS = 256
_CHAT2API_ANTHROPIC_STRUCTURAL_FALLBACK_TOKENS = (
    _CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS + _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
)
_CHAT2API_ANTHROPIC_UNRESOLVED_DOCUMENT_TOKENS = 4_096
# These fields describe the block itself or transport metadata.  Citation
# objects contain user-visible fields such as ``cited_text`` and ``title``;
# they must remain in the token-count traversal when replaying assistant
# messages through Anthropic's Messages API.
_CHAT2API_ANTHROPIC_STRUCTURAL_FIELDS = frozenset({"type", "cache_control"})
_CHAT2API_ANTHROPIC_ENCRYPTED_FIELDS = frozenset({"signature", "encrypted_content", "encrypted_stdout"})


def _chat2api_skip_anthropic_field(content_type: Any, field_name: str) -> bool:
    return (
        field_name in _CHAT2API_ANTHROPIC_STRUCTURAL_FIELDS
        or field_name in _CHAT2API_ANTHROPIC_ENCRYPTED_FIELDS
        or field_name.startswith("encrypted_")
        or (content_type == "redacted_thinking" and field_name == "data")
    )


def _chat2api_text_token_estimate(value: str, start: int = 0) -> int:
    """Match Chat2API's Qwen transcript estimate without allocating a copy."""
    character_count = max(0, len(value) - start)
    if value.isascii():
        return (character_count + 2) // 3

    ascii_characters = sum(
        1 for index in range(start, len(value)) if ord(value[index]) <= 0x7F
    )
    return (ascii_characters + 2) // 3 + character_count - ascii_characters


def _chat2api_new_count_state() -> dict[str, Any]:
    return {
        "nodes": 0,
        "text_chars": 0,
        "truncated": False,
        "fallback_tokens": 0,
        "fallback_inspections": 0,
        "fallback_exhausted": False,
    }


def _chat2api_count_text_bounded(
    value: str,
    count_function: TokenCounterFunction,
    state: dict[str, Any],
) -> int:
    """Tokenize text in bounded chunks and flag a conservative fallback on exhaustion."""
    if not value:
        return 0

    if state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    available = _CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS - state["text_chars"]
    if available <= 0:
        state["truncated"] = True
        state["fallback_tokens"] += _chat2api_text_token_estimate(value)
        return 0

    if len(value) <= _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS and len(value) <= available:
        state["text_chars"] += len(value)
        try:
            return count_function(value)
        except Exception:
            state["truncated"] = True
            state["fallback_tokens"] += _chat2api_text_token_estimate(value)
            return 0

    text = value[:available]
    state["text_chars"] += len(text)
    if len(text) != len(value):
        state["truncated"] = True
        state["fallback_tokens"] += _chat2api_text_token_estimate(value, start=len(text))

    tokens = 0
    for offset in range(0, len(text), _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS):
        chunk = text[offset : offset + _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS]
        try:
            tokens += count_function(chunk)
        except Exception:
            state["truncated"] = True
            tokens += _chat2api_text_token_estimate(chunk)
            remaining = text[offset + len(chunk) :]
            state["fallback_tokens"] += _chat2api_text_token_estimate(remaining)
            break
    return tokens


def _chat2api_count_text_safe(value: str, count_function: TokenCounterFunction) -> int:
    state = _chat2api_new_count_state()
    tokens = _chat2api_count_text_bounded(value, count_function, state)
    return tokens + state["fallback_tokens"]


def _chat2api_exhaust_fallback_inspection(state: dict[str, Any]) -> None:
    if state["fallback_exhausted"]:
        return
    state["fallback_exhausted"] = True
    state["fallback_tokens"] += _CHAT2API_ANTHROPIC_STRUCTURAL_FALLBACK_TOKENS


def _chat2api_add_fallback_value(value: Any, state: dict[str, Any]) -> None:
    """Inspect an unprocessed value with a shared bound and without copying it."""
    if state["fallback_exhausted"]:
        return

    pending: list[tuple[Any, Optional[str], Optional[str]]] = [(value, None, None)]
    while pending:
        if state["fallback_inspections"] >= _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS:
            _chat2api_exhaust_fallback_inspection(state)
            return

        current, field_name, parent_type = pending.pop()
        state["fallback_inspections"] += 1
        if field_name is not None and _chat2api_skip_anthropic_field(parent_type, field_name):
            continue

        if isinstance(current, str):
            state["fallback_tokens"] += max(1, _chat2api_text_token_estimate(current))
            continue
        if current is None:
            state["fallback_tokens"] += 1
            continue
        if isinstance(current, bool):
            state["fallback_tokens"] += 5
            continue
        if isinstance(current, (int, float)):
            state["fallback_tokens"] += max(1, len(str(current)))
            continue
        if isinstance(current, (bytes, bytearray)):
            state["fallback_tokens"] += max(1, len(current))
            continue

        if isinstance(current, Mapping):
            state["fallback_tokens"] += 1 + len(current) * 2
            content_type = current.get("type")
            available = (
                _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS
                - state["fallback_inspections"]
                - len(pending)
            )
            if available <= 0:
                _chat2api_exhaust_fallback_inspection(state)
                return
            appended = 0
            for key, nested_value in current.items():
                nested_field = key if isinstance(key, str) else type(key).__name__
                if _chat2api_skip_anthropic_field(content_type, nested_field):
                    continue
                if appended >= available:
                    _chat2api_exhaust_fallback_inspection(state)
                    return
                state["fallback_tokens"] += _chat2api_text_token_estimate(nested_field)
                pending.append((nested_value, nested_field, content_type))
                appended += 1
            continue

        if isinstance(current, (list, tuple)):
            state["fallback_tokens"] += 1 + len(current) * 2
            available = (
                _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS
                - state["fallback_inspections"]
                - len(pending)
            )
            if available <= 0:
                _chat2api_exhaust_fallback_inspection(state)
                return
            for index, item in enumerate(current):
                if index >= available:
                    _chat2api_exhaust_fallback_inspection(state)
                    return
                pending.append((item, field_name, parent_type))
            continue

        _chat2api_exhaust_fallback_inspection(state)
        return


def _chat2api_count_anthropic_document_source(
    source: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: dict[str, Any],
    depth: int,
) -> int:
    if state["truncated"]:
        _chat2api_add_fallback_value(source, state)
        return 0

    if not isinstance(source, Mapping):
        return _chat2api_count_anthropic_value_inner(
            source,
            count_function,
            use_default_image_token_count,
            state,
            depth=depth + 1,
        )

    source_type = source.get("type")
    state["nodes"] += 1
    if (
        state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
        or len(source) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
    ):
        state["truncated"] = True
        _chat2api_add_fallback_value(source, state)
        return 0

    tokens = 1 + len(source)
    if source_type in {"file", "url"}:
        # Provider-side documents cannot be dereferenced by the local proxy.
        tokens += _CHAT2API_ANTHROPIC_UNRESOLVED_DOCUMENT_TOKENS

    for key, nested_value in source.items():
        nested_field = key if isinstance(key, str) else type(key).__name__
        if _chat2api_skip_anthropic_field(source_type, nested_field):
            continue

        tokens += _chat2api_count_text_bounded(nested_field, count_function, state)
        if source_type == "base64" and nested_field == "data" and isinstance(nested_value, str):
            # Encoded documents can be many MiB and pathological for BPE
            # tokenizers. Encoded length is a conservative, constant-work cost.
            tokens += len(nested_value)
        elif source_type in {"file", "url"} and nested_field in {"file_id", "url"}:
            # Opaque provider references are not document text. Count only a
            # small bounded identifier contribution in addition to the generic
            # unresolved-document allowance above.
            if isinstance(nested_value, str):
                tokens += min(_chat2api_text_token_estimate(nested_value), 4_096)
        else:
            tokens += _chat2api_count_anthropic_value_inner(
                nested_value,
                count_function,
                use_default_image_token_count,
                state,
                depth=depth + 1,
            )
        if state["nodes"] >= _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(source, state)
            break
        if state["truncated"] and state["fallback_exhausted"]:
            break
    return tokens


def _chat2api_count_anthropic_value_inner(
    value: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: dict[str, Any],
    field_name: Optional[str] = None,
    depth: int = 0,
) -> int:
    if state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    if depth > _CHAT2API_ANTHROPIC_MAX_CONTENT_DEPTH:
        state["truncated"] = True
        _chat2api_add_fallback_value(value, state)
        return 0

    state["nodes"] += 1
    if state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
        state["truncated"] = True
        _chat2api_add_fallback_value(value, state)
        return 0

    if isinstance(value, str):
        return _chat2api_count_text_bounded(value, count_function, state)

    if isinstance(value, Mapping):
        content_type = value.get("type")
        if content_type == "image":
            image_url = _chat2api_anthropic_image_url(value.get("source"))
            return _count_image_tokens(image_url, use_default_image_token_count)
        if content_type == "image_url":
            return _count_image_tokens(value.get("image_url"), use_default_image_token_count)

        if len(value) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(value, state)
            return 0

        # Include lightweight JSON object/separator overhead. Keys and scalar
        # values are counted below, unlike LiteLLM's old unknown-block path.
        tokens = 1 + len(value)
        for key, nested_value in value.items():
            nested_field = key if isinstance(key, str) else type(key).__name__
            if _chat2api_skip_anthropic_field(content_type, nested_field):
                continue

            tokens += _chat2api_count_text_bounded(nested_field, count_function, state)
            if content_type == "document" and nested_field == "source":
                tokens += _chat2api_count_anthropic_document_source(
                    nested_value,
                    count_function,
                    use_default_image_token_count,
                    state,
                    depth,
                )
            else:
                tokens += _chat2api_count_anthropic_value_inner(
                    nested_value,
                    count_function,
                    use_default_image_token_count,
                    state,
                    field_name=nested_field,
                    depth=depth + 1,
                )
            if state["truncated"] and state["fallback_exhausted"]:
                break
        return tokens

    if isinstance(value, (list, tuple)):
        if len(value) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(value, state)
            return 0
        tokens = 1 + len(value)
        for item in value:
            tokens += _chat2api_count_anthropic_value_inner(
                item,
                count_function,
                use_default_image_token_count,
                state,
                field_name=field_name,
                depth=depth + 1,
            )
            if state["truncated"] and state["fallback_exhausted"]:
                break
        return tokens

    if value is None:
        return _chat2api_count_text_bounded("null", count_function, state)
    if isinstance(value, bool):
        return _chat2api_count_text_bounded("true" if value else "false", count_function, state)
    if isinstance(value, (int, float)):
        return _chat2api_count_text_bounded(str(value), count_function, state)
    if isinstance(value, (bytes, bytearray)):
        state["truncated"] = True
        return len(value)

    state["truncated"] = True
    _chat2api_add_fallback_value(value, state)
    return 0


def _chat2api_count_anthropic_value(
    value: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: Optional[dict[str, Any]] = None,
) -> int:
    """Count current and future Anthropic blocks with bounded, conservative work."""
    owns_state = state is None
    if state is None:
        state = _chat2api_new_count_state()
    elif state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    tokens = _chat2api_count_anthropic_value_inner(
        value,
        count_function,
        use_default_image_token_count,
        state,
    )
    if owns_state:
        tokens += state["fallback_tokens"]
    return tokens


def _count_content_list(
'''
TOKEN_COUNTER_IMAGE_ANCHOR = '''            elif c["type"] == "image_url":
                image_url = c.get("image_url")
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
'''
TOKEN_COUNTER_IMAGE_PATCH = '''            elif c["type"] == "image_url":
                image_url = c.get("image_url")
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
            elif c["type"] == "image":
                image_url = _chat2api_anthropic_image_url(c.get("source"))
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
'''
TOKEN_COUNTER_TOOL_BLOCK_ANCHOR = '''            elif c["type"] in ("tool_use", "tool_result"):
                num_tokens += _count_anthropic_content(
                    c,
                    count_function,
                    use_default_image_token_count,
                    default_token_count,
                )
'''
TOKEN_COUNTER_TOOL_BLOCK_PATCH = '''            elif c["type"] in ("tool_use", "tool_result"):
                num_tokens += _chat2api_count_anthropic_value(
                    c,
                    count_function,
                    use_default_image_token_count,
                    state=chat2api_state,
                )
'''
TOKEN_COUNTER_STATE_ANCHOR = '''    try:
        num_tokens = 0
        for c in content_list:
'''
TOKEN_COUNTER_STATE_PATCH = '''    try:
        num_tokens = 0
        chat2api_state: dict[str, Any] = _chat2api_new_count_state()
        for c in content_list:
'''
TOKEN_COUNTER_CONTENT_TEXT_ANCHOR = '''            if isinstance(c, str):
                num_tokens += count_function(c)
            elif c["type"] == "text":
                num_tokens += count_function(str(c.get("text", "")))
'''
TOKEN_COUNTER_CONTENT_TEXT_PATCH = '''            if isinstance(c, str):
                num_tokens += _chat2api_count_text_bounded(c, count_function, chat2api_state)
            elif c["type"] == "text":
                text = c.get("text", "")
                if not isinstance(text, str):
                    text = ""
                num_tokens += _chat2api_count_text_bounded(text, count_function, chat2api_state)
                if "citations" in c:
                    num_tokens += _chat2api_count_text_bounded(
                        "citations",
                        count_function,
                        chat2api_state,
                    )
                    num_tokens += _chat2api_count_anthropic_value(
                        c.get("citations"),
                        count_function,
                        use_default_image_token_count,
                        state=chat2api_state,
                    )
'''
TOKEN_COUNTER_THINKING_ANCHOR = '''                if thinking_text:
                    num_tokens += count_function(thinking_text)
'''
TOKEN_COUNTER_THINKING_PATCH = '''                if thinking_text:
                    num_tokens += _chat2api_count_text_bounded(
                        thinking_text,
                        count_function,
                        chat2api_state,
                    )
'''
TOKEN_COUNTER_TOOL_REFERENCE_ANCHOR = '''                if tool_name:
                    num_tokens += count_function(tool_name)
'''
TOKEN_COUNTER_TOOL_REFERENCE_PATCH = '''                if tool_name:
                    num_tokens += _chat2api_count_text_bounded(
                        tool_name,
                        count_function,
                        chat2api_state,
                    )
'''
TOKEN_COUNTER_FALLBACK_ANCHOR = '''            else:
                content_type = c.get("type", type(c).__name__) if isinstance(c, dict) else type(c).__name__
'''
TOKEN_COUNTER_FALLBACK_PATCH = '''            elif isinstance(c, Mapping) and c.get("type"):
                num_tokens += _chat2api_count_anthropic_value(
                    c,
                    count_function,
                    use_default_image_token_count,
                    state=chat2api_state,
                )
            else:
                content_type = c.get("type", type(c).__name__) if isinstance(c, dict) else type(c).__name__
'''
TOKEN_COUNTER_RETURN_ANCHOR = '''        return num_tokens
    except Exception as e:
'''
TOKEN_COUNTER_RETURN_PATCH = '''        if chat2api_state["truncated"]:
            num_tokens += chat2api_state["fallback_tokens"]
        return num_tokens
    except Exception as e:
'''

TOKEN_COUNTER_DIRECT_TEXT_ANCHOR = '''        count_function = _get_count_function(model, custom_tokenizer)
        num_tokens = count_function(text_to_count)
'''
TOKEN_COUNTER_DIRECT_TEXT_PATCH = '''        count_function = _get_count_function(model, custom_tokenizer)
        num_tokens = _chat2api_count_text_safe(text_to_count, count_function)
'''
TOKEN_COUNTER_FUNCTION_CALL_ANCHOR = '''            function_arguments = tool_call["function"].get("arguments", "")
            total += count_function(str(function_arguments))
'''
TOKEN_COUNTER_FUNCTION_CALL_PATCH = '''            function_arguments = tool_call["function"].get("arguments", "")
            if not isinstance(function_arguments, str):
                function_arguments = ""
            total += _chat2api_count_text_safe(function_arguments, count_function)
'''
TOKEN_COUNTER_LEGACY_FUNCTION_CALL_ANCHOR = '''        return count_function(str(value.get("arguments", "")))
'''
TOKEN_COUNTER_LEGACY_FUNCTION_CALL_PATCH = '''        function_arguments = value.get("arguments", "")
        if not isinstance(function_arguments, str):
            function_arguments = ""
        return _chat2api_count_text_safe(function_arguments, count_function)
'''
TOKEN_COUNTER_MESSAGE_TEXT_ANCHOR = '''            elif isinstance(value, str):
                num_tokens += params.count_function(value)
                if key == "name":
'''
TOKEN_COUNTER_MESSAGE_TEXT_PATCH = '''            elif isinstance(value, str):
                num_tokens += _chat2api_count_text_safe(value, params.count_function)
                if key == "name":
'''
TOKEN_COUNTER_SEARCH_RESULTS_ANCHOR = '''                if search_results_text:
                    num_tokens += params.count_function(search_results_text)
'''
TOKEN_COUNTER_SEARCH_RESULTS_PATCH = '''                if search_results_text:
                    num_tokens += _chat2api_count_text_safe(search_results_text, params.count_function)
'''
TOKEN_COUNTER_EXTRA_TOOLS_ANCHOR = '''        num_tokens += count_function(_format_function_definitions(tools))
'''
TOKEN_COUNTER_EXTRA_TOOLS_PATCH = '''        num_tokens += _chat2api_count_text_safe(
            _format_function_definitions(tools),
            count_function,
        )
'''

PROXY_SERVER_MARKER = "count_messages = messages"
PROXY_SERVER_COUNT_ANCHOR = '''    total_tokens = token_counter(
        model=model_to_use,
        text=prompt,
        messages=messages,
        custom_tokenizer=_tokenizer_used,  # type: ignore
    )
'''
PROXY_SERVER_COUNT_PATCH = '''    count_messages = messages
    if messages is not None:
        count_messages = list(messages)
        if system is not None and not any(
            isinstance(message, dict) and message.get("role") == "system"
            for message in count_messages
        ):
            count_messages.insert(0, {"role": "system", "content": system})

    total_tokens = await asyncio.to_thread(
        token_counter,
        model=model_to_use,
        text=prompt,
        messages=count_messages,
        tools=tools if count_messages is not None else None,
        custom_tokenizer=_tokenizer_used,  # type: ignore
    )
'''

ANTHROPIC_ENDPOINTS_MARKER = "def _chat2api_anthropic_count_tokens_local_only("
ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR = "from fastapi import APIRouter, Depends, HTTPException, Request, Response\n"
ANTHROPIC_ENDPOINTS_PATCHED_IMPORTS = "import os\n" + ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR
ANTHROPIC_ENDPOINTS_ROUTE_ANCHOR = '''@router.post(
    "/v1/messages/count_tokens",
'''
ANTHROPIC_ENDPOINTS_PATCHED_HELPERS = '''def _chat2api_anthropic_count_tokens_local_only() -> bool:
    """Prefer the local tokenizer when the target lacks Responses token APIs."""
    value = os.environ.get("LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY", "true")
    return value.strip().lower() not in {"0", "false", "no", "off"}


@router.post(
    "/v1/messages/count_tokens",
'''
ANTHROPIC_ENDPOINTS_CALL_ANCHOR = '''        token_response = await internal_token_counter(
            request=token_request,
            call_endpoint=True,
        )
'''
ANTHROPIC_ENDPOINTS_CALL_PATCH = '''        token_response = await internal_token_counter(
            request=token_request,
            # Chat2API exposes Chat Completions, not /responses/input_tokens.
            # Keep local counting as the generic default; deployments with a
            # real provider counting API can opt out through the environment.
            call_endpoint=not _chat2api_anthropic_count_tokens_local_only(),
        )
'''

ANTHROPIC_ADAPTER_TOOL_ERROR_MARKER = "tool_result_error_by_id: Dict[str, bool]"
ANTHROPIC_ADAPTER_TOOL_ERROR_STATE_ANCHOR = '''            tool_message_list: List[ChatCompletionToolMessage] = []
            new_user_content_list: List[Union[ChatCompletionTextObject, ChatCompletionImageObject]] = []
'''
ANTHROPIC_ADAPTER_TOOL_ERROR_STATE_PATCH = '''            tool_message_list: List[ChatCompletionToolMessage] = []
            tool_result_error_by_id: Dict[str, bool] = {}
            new_user_content_list: List[Union[ChatCompletionTextObject, ChatCompletionImageObject]] = []
'''
ANTHROPIC_ADAPTER_TOOL_ERROR_CAPTURE_ANCHOR = '''                        elif content.get("type") == "tool_result":
                            if "content" not in content:
'''
ANTHROPIC_ADAPTER_TOOL_ERROR_CAPTURE_PATCH = '''                        elif content.get("type") == "tool_result":
                            tool_use_id = str(content.get("tool_use_id", ""))
                            is_error = content.get("is_error")
                            if isinstance(is_error, bool):
                                tool_result_error_by_id[tool_use_id] = is_error

                            if "content" not in content:
'''
ANTHROPIC_ADAPTER_TOOL_ERROR_FORWARD_ANCHOR = '''            if len(tool_message_list) > 0:
                new_messages.extend(tool_message_list)
'''
ANTHROPIC_ADAPTER_TOOL_ERROR_FORWARD_PATCH = '''            if len(tool_message_list) > 0:
                for tool_message in tool_message_list:
                    tool_call_id = str(tool_message.get("tool_call_id", ""))
                    if tool_call_id in tool_result_error_by_id:
                        cast(Dict[str, Any], tool_message)["is_error"] = tool_result_error_by_id[tool_call_id]
                new_messages.extend(tool_message_list)
'''

ANTHROPIC_RESPONSES_TOOL_ERROR_MARKER = 'tool_result_item["is_error"] = is_error'
ANTHROPIC_RESPONSES_TOOL_CONTENT_MARKER = (
    "Preserve structured Anthropic tool-result images"
)
ANTHROPIC_RESPONSES_TOOL_CONTENT_ANCHOR = '''                            elif isinstance(inner, list):
                                parts = [
                                    c.get("text", "") for c in inner if isinstance(c, dict) and c.get("type") == "text"
                                ]
                                output_text = "\\n".join(parts)
'''
ANTHROPIC_RESPONSES_TOOL_CONTENT_PATCH = '''                            elif isinstance(inner, list):
                                # Preserve structured Anthropic tool-result images so clients such
                                # as Claude Code can return screenshots through Responses.
                                structured_output: List[Dict[str, Any]] = []
                                text_parts: List[str] = []
                                has_image = False
                                for content_part in inner:
                                    if isinstance(content_part, str):
                                        text_value = content_part
                                    elif isinstance(content_part, dict) and content_part.get("type") == "text":
                                        raw_text = content_part.get("text", "")
                                        text_value = raw_text if isinstance(raw_text, str) else str(raw_text)
                                    else:
                                        text_value = None

                                    if text_value is not None:
                                        text_parts.append(text_value)
                                        structured_output.append(
                                            {"type": "input_text", "text": text_value}
                                        )
                                        continue

                                    if isinstance(content_part, dict) and content_part.get("type") == "image":
                                        image_url = self._translate_anthropic_image_source_to_url(
                                            cast(dict, content_part.get("source", {}))
                                        )
                                        if image_url:
                                            has_image = True
                                            structured_output.append(
                                                {"type": "input_image", "image_url": image_url}
                                            )

                                output_text = structured_output if has_image else "\\n".join(text_parts)
'''
ANTHROPIC_RESPONSES_TOOL_ERROR_ANCHOR = '''                            # tool_result is a top-level item, not inside the message
                            input_items.append(
                                {
                                    "type": "function_call_output",
                                    "call_id": tool_use_id,
                                    "output": output_text,
                                }
                            )
'''
ANTHROPIC_RESPONSES_TOOL_ERROR_PATCH = '''                            # Preserve Anthropic's tool failure bit as a Chat2API extension.
                            tool_result_item: Dict[str, Any] = {
                                "type": "function_call_output",
                                "call_id": tool_use_id,
                                "output": output_text,
                            }
                            is_error = block.get("is_error")
                            if isinstance(is_error, bool):
                                tool_result_item["is_error"] = is_error
                            input_items.append(tool_result_item)
'''
ANTHROPIC_RESPONSES_ASSISTANT_ORDER_MARKER = (
    "Flush buffered assistant text before the top-level tool call"
)
ANTHROPIC_RESPONSES_ASSISTANT_ORDER_ANCHOR = '''                        elif btype == "tool_use":
                            # tool_use becomes a top-level function_call item
                            input_items.append(
                                {
                                    "type": "function_call",
                                    "call_id": block.get("id", ""),
                                    "name": block.get("name", ""),
                                    "arguments": json.dumps(block.get("input", {})),
                                }
                            )
'''
ANTHROPIC_RESPONSES_ASSISTANT_ORDER_PATCH = '''                        elif btype == "tool_use":
                            # Flush buffered assistant text before the top-level tool call
                            # so Responses input items retain Anthropic content-block order.
                            if asst_parts:
                                input_items.append(
                                    {
                                        "type": "message",
                                        "role": "assistant",
                                        "content": asst_parts,
                                    }
                                )
                                asst_parts = []
                            # tool_use becomes a top-level function_call item
                            input_items.append(
                                {
                                    "type": "function_call",
                                    "call_id": block.get("id", ""),
                                    "name": block.get("name", ""),
                                    "arguments": json.dumps(block.get("input", {})),
                                }
                            )
'''


def replace_exact(source: str, old: str, new: str, description: str) -> str:
    occurrences = source.count(old)
    if occurrences != 1:
        raise RuntimeError(
            f"Expected exactly one {description} in the pinned LiteLLM source; "
            f"found {occurrences}. Refusing to apply a potentially unsafe patch."
        )
    return source.replace(old, new, 1)


def replace_region(source: str, start_marker: str, end_marker: str, new: str, description: str) -> str:
    start = source.find(start_marker)
    if start < 0 or source.find(start_marker, start + 1) >= 0:
        raise RuntimeError(f"Expected one {description} start marker in the installed LiteLLM source.")
    end = source.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"Could not find {description} end marker in the installed LiteLLM source.")
    return source[:start] + new + source[end:]


def replace_to_end(source: str, start_marker: str, new: str, description: str) -> str:
    start = source.find(start_marker)
    if start < 0 or source.find(start_marker, start + 1) >= 0:
        raise RuntimeError(f"Expected one {description} start marker in the installed LiteLLM source.")
    return source[:start] + new


def patch_source(source: str) -> str:
    if "def _mid_stream_error_sse_event(" in source:
        raise RuntimeError(
            "LiteLLM already contains a mid-stream Anthropic error patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        STANDARD_IMPORT_ANCHOR,
        PATCHED_STANDARD_IMPORTS,
        "standard import anchor",
    )
    patched = replace_exact(patched, IMPORT_ANCHOR, PATCHED_IMPORTS, "import anchor")
    patched = replace_exact(patched, HELPER_ANCHOR, PATCHED_HELPERS, "helper anchor")
    patched = replace_exact(patched, ORIGINAL_WRAPPER, PATCHED_WRAPPER, "async SSE wrapper")
    compile(patched, str(MODULE_PATH), "exec")
    return patched


def upgrade_source(source: str) -> str:
    """Refresh the error extraction in an overlay made by an older revision."""
    if "_CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH" in source:
        raise RuntimeError("LiteLLM standard Anthropic error extraction is already current.")
    if "def _mid_stream_error_sse_event(" not in source:
        raise RuntimeError("The target is not an existing Chat2API Anthropic stream overlay.")

    patched = replace_exact(
        source,
        LEGACY_STANDARD_IMPORTS,
        LEGACY_STANDARD_IMPORTS.replace("import os\n", "import os\nimport re\n"),
        "legacy standard imports",
    )
    helper_start = "if TYPE_CHECKING:\n    from litellm.types.utils import ModelResponseStream\n"
    helper_end = "class _CombinedChunkSplitter:"
    helper_region = PATCHED_HELPERS.split(helper_end, 1)[0]
    patched = replace_region(
        patched,
        helper_start,
        helper_end,
        helper_region,
        "standard Anthropic helper region",
    )
    compile(patched, str(MODULE_PATH), "exec")
    return patched


def upgrade_responses_source(source: str) -> str:
    """Refresh error extraction in an existing Responses compatibility overlay."""
    if "_CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH" in source:
        raise RuntimeError("LiteLLM Responses error extraction is already current.")
    if "def _anthropic_responses_error_event(" not in source:
        raise RuntimeError("The target is not an existing Chat2API Responses overlay.")

    patched = replace_exact(
        source,
        LEGACY_RESPONSES_IMPORTS,
        LEGACY_RESPONSES_IMPORTS.replace("import os\n", "import os\nimport re\n"),
        "legacy Responses imports",
    )
    helper_start = "from litellm._uuid import uuid\n"
    helper_end = "class AnthropicResponsesStreamWrapper:"
    helper_region = RESPONSES_PATCHED_HELPERS.rsplit(helper_end, 1)[0]
    patched = replace_region(
        patched,
        helper_start,
        helper_end,
        helper_region,
        "Responses Anthropic helper region",
    )
    if RESPONSES_STATE_PATCH not in patched:
        patched = replace_exact(
            patched,
            RESPONSES_STATE_ANCHOR,
            RESPONSES_STATE_PATCH,
            "legacy Responses terminal state",
        )
    event_start = "    @staticmethod\n    def _event_field"
    event_end = "    def _process_event"
    event_helpers = RESPONSES_PROCESS_EVENT_PATCH.split(event_end, 1)[0]
    patched = replace_region(
        patched,
        event_start,
        event_end,
        event_helpers,
        "legacy Responses event helpers",
    )
    old_event_call = "self._queue_terminal_error(self._event_error_message(event))"
    new_event_call = "self._queue_terminal_error(event, self._event_error_message(event))"
    if patched.count(old_event_call) != 2:
        raise RuntimeError("Expected two legacy Responses event error call sites.")
    patched = patched.replace(old_event_call, new_event_call)
    patched = replace_exact(
        patched,
        'self._queue_terminal_error(str(exc) or "Upstream Responses transport failed")',
        'self._queue_terminal_error(exc, str(exc) or "Upstream Responses transport failed")',
        "legacy Responses transport error call",
    )
    patched = replace_exact(
        patched,
        'self._queue_terminal_error(\n                "Upstream Responses stream ended before response.completed"\n            )',
        'self._queue_terminal_error(\n                None,\n                "Upstream Responses stream ended before response.completed",\n            )',
        "legacy Responses EOF error call",
    )
    patched = replace_exact(
        patched,
        '_anthropic_responses_error_event(\n                    str(exc) or "Upstream Responses transport failed"\n                )',
        '_anthropic_responses_error_event(\n                    exc,\n                    str(exc) or "Upstream Responses transport failed",\n                )',
        "legacy Responses wrapper error call",
    )
    wrapper_start = "    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:"
    patched = replace_to_end(
        patched,
        wrapper_start,
        RESPONSES_PATCHED_WRAPPER,
        "legacy Responses SSE wrapper",
    )
    compile(patched, str(RESPONSES_MODULE_PATH), "exec")
    return patched


def patch_or_upgrade_source(source: str) -> str:
    if "_CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH" in source:
        raise RuntimeError("LiteLLM standard Anthropic error extraction is already current.")
    if "def _mid_stream_error_sse_event(" in source:
        return upgrade_source(source)
    return patch_source(source)


def patch_or_upgrade_responses_source(source: str) -> str:
    if "_CHAT2API_ANTHROPIC_ERROR_MAX_DEPTH" in source:
        raise RuntimeError("LiteLLM Responses error extraction is already current.")
    if "def _anthropic_responses_error_event(" in source:
        return upgrade_responses_source(source)
    return patch_responses_source(source)


def patch_responses_source(source: str) -> str:
    if "def _anthropic_responses_error_event(" in source:
        raise RuntimeError(
            "LiteLLM Responses Anthropic terminal/error patch is already present; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        RESPONSES_IMPORT_ANCHOR,
        RESPONSES_PATCHED_IMPORTS,
        "Responses import anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_HELPER_ANCHOR,
        RESPONSES_PATCHED_HELPERS,
        "Responses helper anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_STATE_ANCHOR,
        RESPONSES_STATE_PATCH,
        "Responses terminal state anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_PROCESS_EVENT_ANCHOR,
        RESPONSES_PROCESS_EVENT_PATCH,
        "Responses event helper anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_CREATED_ANCHOR,
        RESPONSES_CREATED_PATCH,
        "Responses message-start anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_OUTPUT_ITEM_ANCHOR,
        RESPONSES_OUTPUT_ITEM_PATCH,
        "Responses error event anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_TERMINAL_ANCHOR,
        RESPONSES_TERMINAL_PATCH,
        "Responses failed terminal anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_ANEXT_ANCHOR,
        RESPONSES_ANEXT_PATCH,
        "Responses transport termination anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_ORIGINAL_WRAPPER,
        RESPONSES_PATCHED_WRAPPER,
        "Responses async SSE wrapper",
    )
    compile(patched, str(RESPONSES_MODULE_PATH), "exec")
    return patched


def patch_responses_iterator_source(source: str) -> str:
    """Preserve structured errors in LiteLLM's generic Responses iterator."""
    if RESPONSES_ITERATOR_ERROR_DETAILS_MARKER in source:
        raise RuntimeError(
            "LiteLLM generic Responses iterator error patch is already present; "
            "review the base image before removing this build patch."
        )
    if "def _chat2api_responses_error_field(" in source:
        raise RuntimeError(
            "LiteLLM generic Responses iterator contains an unknown partial "
            "Chat2API patch; review the base image before applying this patch."
        )

    client_error_codes = RESPONSES_ITERATOR_ERROR_HELPERS_ANCHOR.split(
        "\n\n\ndef _error_event_fields",
        1,
    )[0]
    patched = replace_exact(
        source,
        RESPONSES_ITERATOR_ERROR_HELPERS_ANCHOR,
        RESPONSES_ITERATOR_ERROR_HELPERS + "\n\n" + client_error_codes,
        "generic Responses iterator error helper anchor",
    )
    patched = replace_region(
        patched,
        "    def _handle_logging_failed_response(self):",
        "    def _get_completed_response_object(self)",
        RESPONSES_ITERATOR_FAILURE_HANDLERS,
        "generic Responses iterator failure handlers",
    )
    compile(patched, str(RESPONSES_STREAMING_ITERATOR_MODULE_PATH), "exec")
    return patched


def upgrade_responses_iterator_source(source: str) -> str:
    """Refresh a generic Responses iterator overlay from the prior revision."""
    if RESPONSES_ITERATOR_ERROR_DETAILS_MARKER not in source:
        raise RuntimeError(
            "The target is not an existing Chat2API generic Responses iterator overlay."
        )
    if (
        'if error_type in {"error", "response.failed"}' in source
        and "fallback_exception = MidStreamFallbackError(" in source
    ):
        raise RuntimeError(
            "LiteLLM generic Responses iterator error extraction is already current."
        )

    helper_start = RESPONSES_ITERATOR_ERROR_DETAILS_MARKER
    helper_end = "_CLIENT_ERROR_CODES: frozenset[str] = frozenset("
    patched = replace_region(
        source,
        helper_start,
        helper_end,
        RESPONSES_ITERATOR_ERROR_HELPERS + "\n\n",
        "legacy generic Responses iterator error helpers",
    )
    patched = replace_region(
        patched,
        "    def _handle_logging_failed_response(self):",
        "    def _get_completed_response_object(self)",
        RESPONSES_ITERATOR_FAILURE_HANDLERS,
        "legacy generic Responses iterator failure handlers",
    )
    compile(patched, str(RESPONSES_STREAMING_ITERATOR_MODULE_PATH), "exec")
    return patched


def patch_or_upgrade_responses_iterator_source(source: str) -> str:
    """Apply the generic Responses iterator patch with explicit upgrade checks."""
    if RESPONSES_ITERATOR_ERROR_DETAILS_MARKER in source:
        return upgrade_responses_iterator_source(source)
    return patch_responses_iterator_source(source)


def patch_responses_main_source(source: str) -> str:
    if RESPONSES_NATIVE_STREAM_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the Responses native-stream model-info patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        RESPONSES_NATIVE_STREAM_ANCHOR,
        RESPONSES_NATIVE_STREAM_PATCH,
        "Responses native-stream model-info anchor",
    )
    compile(patched, str(RESPONSES_MAIN_MODULE_PATH), "exec")
    return patched


def patch_token_counter_source(source: str) -> str:
    if TOKEN_COUNTER_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the Anthropic image token-count patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        TOKEN_COUNTER_HELPER_ANCHOR,
        TOKEN_COUNTER_PATCHED_HELPERS,
        "token-counter Anthropic image helper anchor",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_STATE_ANCHOR,
        TOKEN_COUNTER_STATE_PATCH,
        "token-counter shared bounded state",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_CONTENT_TEXT_ANCHOR,
        TOKEN_COUNTER_CONTENT_TEXT_PATCH,
        "token-counter bounded content text branches",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_THINKING_ANCHOR,
        TOKEN_COUNTER_THINKING_PATCH,
        "token-counter bounded thinking branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_TOOL_REFERENCE_ANCHOR,
        TOKEN_COUNTER_TOOL_REFERENCE_PATCH,
        "token-counter bounded tool-reference branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_IMAGE_ANCHOR,
        TOKEN_COUNTER_IMAGE_PATCH,
        "token-counter image branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_TOOL_BLOCK_ANCHOR,
        TOKEN_COUNTER_TOOL_BLOCK_PATCH,
        "token-counter bounded Anthropic tool blocks",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_FALLBACK_ANCHOR,
        TOKEN_COUNTER_FALLBACK_PATCH,
        "token-counter Anthropic compatibility fallback",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_RETURN_ANCHOR,
        TOKEN_COUNTER_RETURN_PATCH,
        "token-counter conservative fallback return",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_DIRECT_TEXT_ANCHOR,
        TOKEN_COUNTER_DIRECT_TEXT_PATCH,
        "token-counter bounded direct text path",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_FUNCTION_CALL_ANCHOR,
        TOKEN_COUNTER_FUNCTION_CALL_PATCH,
        "token-counter bounded tool call arguments",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_LEGACY_FUNCTION_CALL_ANCHOR,
        TOKEN_COUNTER_LEGACY_FUNCTION_CALL_PATCH,
        "token-counter bounded legacy function arguments",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_MESSAGE_TEXT_ANCHOR,
        TOKEN_COUNTER_MESSAGE_TEXT_PATCH,
        "token-counter bounded message text",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_SEARCH_RESULTS_ANCHOR,
        TOKEN_COUNTER_SEARCH_RESULTS_PATCH,
        "token-counter bounded search results",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_EXTRA_TOOLS_ANCHOR,
        TOKEN_COUNTER_EXTRA_TOOLS_PATCH,
        "token-counter bounded tool definitions",
    )
    compile(patched, str(TOKEN_COUNTER_MODULE_PATH), "exec")
    return patched


def patch_proxy_server_source(source: str) -> str:
    if PROXY_SERVER_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the token-counter extras patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        PROXY_SERVER_COUNT_ANCHOR,
        PROXY_SERVER_COUNT_PATCH,
        "proxy token-counter extras anchor",
    )
    compile(patched, str(PROXY_SERVER_MODULE_PATH), "exec")
    return patched


def patch_anthropic_endpoints_source(source: str) -> str:
    if ANTHROPIC_ENDPOINTS_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the local Anthropic count-tokens patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR,
        ANTHROPIC_ENDPOINTS_PATCHED_IMPORTS,
        "Anthropic endpoint environment import anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ENDPOINTS_ROUTE_ANCHOR,
        ANTHROPIC_ENDPOINTS_PATCHED_HELPERS,
        "Anthropic count-tokens route anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ENDPOINTS_CALL_ANCHOR,
        ANTHROPIC_ENDPOINTS_CALL_PATCH,
        "Anthropic count-tokens local-first call anchor",
    )
    compile(patched, str(ANTHROPIC_ENDPOINTS_MODULE_PATH), "exec")
    return patched


def patch_anthropic_adapter_source(source: str) -> str:
    if ANTHROPIC_ADAPTER_TOOL_ERROR_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the Anthropic tool-result error bridge patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        ANTHROPIC_ADAPTER_TOOL_ERROR_STATE_ANCHOR,
        ANTHROPIC_ADAPTER_TOOL_ERROR_STATE_PATCH,
        "Anthropic adapter tool-result error state anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ADAPTER_TOOL_ERROR_CAPTURE_ANCHOR,
        ANTHROPIC_ADAPTER_TOOL_ERROR_CAPTURE_PATCH,
        "Anthropic adapter tool-result error capture anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ADAPTER_TOOL_ERROR_FORWARD_ANCHOR,
        ANTHROPIC_ADAPTER_TOOL_ERROR_FORWARD_PATCH,
        "Anthropic adapter tool-result error forward anchor",
    )
    compile(patched, str(ANTHROPIC_ADAPTER_MODULE_PATH), "exec")
    return patched


def patch_anthropic_responses_transformation_source(source: str) -> str:
    patched = source
    if ANTHROPIC_RESPONSES_TOOL_CONTENT_MARKER not in patched:
        patched = replace_exact(
            patched,
            ANTHROPIC_RESPONSES_TOOL_CONTENT_ANCHOR,
            ANTHROPIC_RESPONSES_TOOL_CONTENT_PATCH,
            "Anthropic Responses structured tool-result content anchor",
        )
    if ANTHROPIC_RESPONSES_TOOL_ERROR_MARKER not in patched:
        patched = replace_exact(
            patched,
            ANTHROPIC_RESPONSES_TOOL_ERROR_ANCHOR,
            ANTHROPIC_RESPONSES_TOOL_ERROR_PATCH,
            "Anthropic Responses tool-result error anchor",
        )
    if ANTHROPIC_RESPONSES_ASSISTANT_ORDER_MARKER not in patched:
        patched = replace_exact(
            patched,
            ANTHROPIC_RESPONSES_ASSISTANT_ORDER_ANCHOR,
            ANTHROPIC_RESPONSES_ASSISTANT_ORDER_PATCH,
            "Anthropic Responses assistant content ordering anchor",
        )
    elif patched == source:
        raise RuntimeError(
            "LiteLLM already contains the Anthropic Responses patches; "
            "review the base image before removing this build patch."
        )
    compile(patched, str(ANTHROPIC_RESPONSES_TRANSFORMATION_MODULE_PATH), "exec")
    return patched


def resolve_installed_target(relative_path: Path) -> Path:
    candidates = [Path(root) / relative_path for root in site.getsitepackages()]
    existing = [candidate for candidate in candidates if candidate.is_file()]
    if len(existing) != 1:
        rendered = ", ".join(str(candidate) for candidate in candidates)
        raise RuntimeError(
            f"Expected one installed LiteLLM target for {relative_path}, found {len(existing)}: {rendered}"
        )
    return existing[0]


def resolve_targets() -> list[Path]:
    if len(sys.argv) > 2:
        raise RuntimeError("Usage: apply-anthropic-midstream-error-patch.py [target.py]")
    if len(sys.argv) == 2:
        return [Path(sys.argv[1]).resolve()]

    return [
        resolve_installed_target(MODULE_PATH),
        resolve_installed_target(RESPONSES_MODULE_PATH),
        resolve_installed_target(RESPONSES_STREAMING_ITERATOR_MODULE_PATH),
        resolve_installed_target(RESPONSES_MAIN_MODULE_PATH),
        resolve_installed_target(ANTHROPIC_ADAPTER_MODULE_PATH),
        resolve_installed_target(ANTHROPIC_RESPONSES_TRANSFORMATION_MODULE_PATH),
        resolve_installed_target(TOKEN_COUNTER_MODULE_PATH),
        resolve_installed_target(PROXY_SERVER_MODULE_PATH),
        resolve_installed_target(ANTHROPIC_ENDPOINTS_MODULE_PATH),
    ]


def main() -> None:
    for target in resolve_targets():
        source = target.read_text(encoding="utf-8")
        target_path = target.as_posix()
        if target_path.endswith(RESPONSES_MODULE_PATH.as_posix()):
            patched = patch_or_upgrade_responses_source(source)
        elif target_path.endswith(RESPONSES_STREAMING_ITERATOR_MODULE_PATH.as_posix()):
            patched = patch_or_upgrade_responses_iterator_source(source)
        elif target_path.endswith(RESPONSES_MAIN_MODULE_PATH.as_posix()):
            patched = patch_responses_main_source(source)
        elif target_path.endswith(ANTHROPIC_ADAPTER_MODULE_PATH.as_posix()):
            patched = patch_anthropic_adapter_source(source)
        elif target_path.endswith(ANTHROPIC_RESPONSES_TRANSFORMATION_MODULE_PATH.as_posix()):
            patched = patch_anthropic_responses_transformation_source(source)
        elif target_path.endswith(TOKEN_COUNTER_MODULE_PATH.as_posix()):
            patched = patch_token_counter_source(source)
        elif target_path.endswith(PROXY_SERVER_MODULE_PATH.as_posix()):
            patched = patch_proxy_server_source(source)
        elif target_path.endswith(ANTHROPIC_ENDPOINTS_MODULE_PATH.as_posix()):
            patched = patch_anthropic_endpoints_source(source)
        else:
            patched = patch_or_upgrade_source(source)
        target.write_text(patched, encoding="utf-8")
        py_compile.compile(str(target), doraise=True)
        print(f"Applied Anthropic stream safety patch to {target}")


if __name__ == "__main__":
    main()
