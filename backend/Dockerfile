FROM python:3.12-slim

WORKDIR /app

# Install deps first (layer cache)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ .

# Copy static data files
COPY practice_tests.json answer_keys.json ./

ENV DATA_DIR=/app
ENV PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
