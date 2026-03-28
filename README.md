# Crypto Terminal - Live Market & Intelligence Dashboard

A professional, Bloomberg-inspired financial terminal for tracking cryptocurrency markets, whale movements, and institutional flows. This dashboard provides real-time market intelligence using a Flask backend and a modern HTML/JS frontend, with built-in Cloudflare Tunnel support for secure remote access.

## 🚀 Key Features

*   **Market Summary**: Institutional-grade ticker tracking for top trading pairs.
*   **Whale Watch**: Live tracking of large-scale BTC and ETH movements and institutional ETF flows.
*   **Database Inspector**: Built-in SQLite explorer for monitoring user trades and configuration.
*   **AI Bias Engine**: Real-time sentiment analysis using local LLM integration (Ollama/Minimax).
*   **One-Button Recovery**: Automated startup scripts to restore the ecosystem after power interruptions.
*   **Secure Tunneling**: Zero Trust access via Cloudflare Tunnels (included `config.example.yml`).

## 🛠️ Architecture

*   **Backend**: Python (Flask, Gunicorn)
*   **Frontend**: Vanilla HTML5, CSS3, JavaScript (Real-time WebSockets integration)
*   **Database**: SQLite3
*   **Tunneling**: Cloudflare Tunnel (`cloudflared`)

## 📦 Installation & Setup

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-username/crypto-terminal.git
    cd crypto-terminal
    ```

2.  **Set Up Virtual Environment**:
    ```bash
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    ```

3.  **Configure Environment**:
    *   Rename `config.example.yml` to `config.yml` and add your Cloudflare Tunnel ID.
    *   (Optional) Obtain Google OAuth credentials and place them in `client_secret_crypto.json` if using identity services.

4.  **Launch Ecosystem**:
    ```bash
    chmod +x start.sh
    ./start.sh
    ```

## 📂 Project Structure

*   `server1.py`: Main Flask application handling market data, AI bias, and DB introspection.
*   `testcrypto.html`: Core terminal UI with real-time data streaming.
*   `start.sh`: Robust startup script with process cleanup and health checks.
*   `VIEW_DB.command`: Rapid database inspection utility.

## ⚠️ Security Warning

**DO NOT** upload your actual `terminal.db`, `config.yml` (containing tunnel IDs), or your `client_secret_crypto.json` to any public repository. Use the provided templates to configure your local instance.

---
*Created with 💙 for the Crypto Community.*
