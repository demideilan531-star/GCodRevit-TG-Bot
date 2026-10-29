FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
ENV COLLECTOR_HEALTH_BIND=0.0.0.0
WORKDIR /app
COPY scripts/telegram-account-requirements.txt /app/requirements.txt
RUN pip install --disable-pip-version-check -r requirements.txt \
    && groupadd --gid 10001 collector \
    && useradd --uid 10001 --gid 10001 --no-create-home collector
COPY scripts/telegram_account_sync.py scripts/telegram_account_service.py /app/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).close()"
CMD ["python", "-B", "/app/telegram_account_service.py"]
