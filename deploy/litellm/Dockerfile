ARG LITELLM_BASE_IMAGE=docker.litellm.ai/berriai/litellm:v1.93.0
FROM ${LITELLM_BASE_IMAGE}

COPY apply-anthropic-midstream-error-patch.py /tmp/apply-anthropic-midstream-error-patch.py

RUN /app/.venv/bin/python /tmp/apply-anthropic-midstream-error-patch.py \
    && rm /tmp/apply-anthropic-midstream-error-patch.py

LABEL org.opencontainers.image.description="LiteLLM with Anthropic stream heartbeats and spec-compliant errors"
