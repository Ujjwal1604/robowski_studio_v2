FROM python:3.11-slim

WORKDIR /app

# RDKit wheel runtime system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxrender1 libxext6 libexpat1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
RUN uv sync --no-dev

COPY app.py .

ENV ROBOWSKI_HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["uv", "run", "--no-sync", "app.py"]
