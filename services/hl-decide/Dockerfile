FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY services/hl-decide/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY contracts ./contracts
COPY services/hl-decide ./services/hl-decide

CMD ["uvicorn", "services.hl-decide.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
