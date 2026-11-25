FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/ scripts/
COPY dados/ /opt/calc-id/fontes/
RUN ln -s /data/dados dados && ln -s /data/resultados resultados

CMD ["sh", "scripts/iniciar_railway.sh"]
