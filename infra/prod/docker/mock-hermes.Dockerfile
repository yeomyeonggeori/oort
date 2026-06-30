# syntax=docker/dockerfile:1
#
# Repo-local OpenAI-compatible mock packaged as an image so the internal
# host-runtime smoke can run without a source checkout bind mount.

FROM python:3.12-slim
WORKDIR /app
COPY scripts/mock_hermes.py /app/mock_hermes.py
EXPOSE 8088
ENTRYPOINT ["python3", "/app/mock_hermes.py", "--host", "0.0.0.0", "--port", "8088"]
