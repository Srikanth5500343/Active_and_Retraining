FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    libgl1 libglib2.0-0 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

COPY client/package*.json ./client/
RUN cd client && npm install

COPY . .

RUN cd client && npm run build

ENV PORT=10000
ENV PYTHON_PATH=python3
EXPOSE 10000

CMD ["node", "server/app.js"]
