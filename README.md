# AETHER 🌐

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)
![Solana](https://img.shields.io/badge/Solana-passing-14F195.svg?logo=solana&logoColor=black)

### Elevator Pitch
**AETHER** is a pristine, offline-first payment platform that ensures secure Solana transactions in zero-connectivity environments, powered entirely by local, decentralized AI for a true sovereign financial experience.

### 🏆 Tether QVAC Track Integration
AETHER is uniquely designed to fulfill the **Tether QVAC $10k Side Track** requirements by bridging local AI with decentralized finance. **We definitively do not use cloud AI APIs.** Every step of the intent parsing and transaction generation is securely executed 100% on-device:
*   **Local Voice-to-Text:** We utilize `@qvac/transcription-whispercpp` within the Tether QVAC SDK for highly accurate, offline voice recognition (e.g., *"Send 10 USDT to vendor"*).
*   **Local LLM Intent Parsing:** The transcription is immediately processed using `@qvac/llm-llamacpp` to parse intent into a structured JSON transaction payload.
*   **Offline Transaction Generation:** This data strictly parameters the generation of an offline transaction, completely isolating sensitive user intent from the public internet.

### ⚠️ The Problem & 💡 The Solution
**The Problem:** Traditional Web3 payment infrastructure is fundamentally fragile; it suffers immediate failure in blackout zones, during natural disasters, or in simple low-connectivity environments. 
**The Solution:** AETHER utilizes an **Offline-First + P2P Bridge architecture**. It securely signs payloads completely offline using Solana Durable Nonces. When a sender (offline) interacts with a receiver terminal (online, e.g., a merchant POS), the transaction is seamlessly bridged via a local **Hyperswarm P2P** connection.

### ⚙️ Architecture & Tech Stack

| Component | Technology Stack |
| :--- | :--- |
| **Frontend** | React, Tailwind CSS, Biometric WebAuthn |
| **Backend/Bridge** | Node.js, Hyperswarm (P2P Networking) |
| **AI Layer** | Tether QVAC SDK (`@qvac/transcription-whispercpp`, `@qvac/llm-llamacpp`) |
| **Blockchain** | Solana (Durable Nonces) |

### 🚀 Quick Start (How to Run Locally)

Follow these exact terminal commands to initiate the Aether environment:

1. **Install Dependencies** (Root & Frontend):
```bash
npm install
cd frontend && npm install
```

2. **Start the Receiver Terminal:**
Ensure you are in the project root.
```bash
npm run receiver
```

3. **Start the Local Bridge:**
Ensure you are in the project root.
```bash
npm run bridge
```

4. **Start the Enterprise Frontend:**
```bash
cd frontend
npm run dev
```

### 🎥 Demo Video
[Watch the Demo Here](#) *(Replace with YouTube/Loom link)*
