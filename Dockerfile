FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Europe/Warsaw \
    MAPA_HOST=0.0.0.0 \
    MAPA_PORT=8000 \
    MAPA_DATA=/data/mapa_dane.xlsx

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY static/ static/

# Dane (mapa_dane.xlsx + folder "kopie") są w wolumenie /data, nie w obrazie.
VOLUME ["/data"]
EXPOSE 8000
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/version', timeout=4)" || exit 1

CMD ["python", "server.py", "--no-browser"]
