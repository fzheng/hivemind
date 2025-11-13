FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY services/hl-sage/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY contracts ./contracts
COPY services/hl-sage ./services/hl-sage

CMD ["uvicorn", "services.hl-sage.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
