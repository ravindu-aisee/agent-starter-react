# Track Bus LiveKit Agent Starter (React)

This project is a Next.js-based starter for building real-time voice, video, and AI-powered applications using LiveKit, Google Cloud Vision OCR, Google TTS, and on-device ML models (TFLite/ONNX). It is designed for rapid prototyping of agent and computer vision features.

## Features

- Real-time voice
- Google Cloud Vision OCR API integration (via environment variables)
- Google Cloud Text-to-Speech (TTS) API integration
- Camera capture and image upload
- On-device model inference (TFLite/ONNX) for object detection/recognition
- Model files included in `public/models`
- Modern UI with theme switching and customizable branding
- Modular React components and hooks

## Project Structure

```
agent-starter-react/
├── app/
│   ├── api/
│   │   ├── ocr/           # OCR API route (Google Vision)
│   │   ├── tts/           # TTS API route (Google TTS)
│   │   └── ...
│   ├── detections/        # Detection UI
│   ├── ui/                # Main UI pages
│   └── ...
├── components/
│   ├── app/               # App-specific components
│   └── livekit/           # LiveKit UI components
├── hooks/                 # Custom React hooks
├── lib/                   # Utility and ML loader code
├── public/
│   ├── models/            # TFLite/ONNX model files
│   ├── onnx-wasm/         # ONNX WASM runtime files
│   └── ...
├── styles/                # Global styles
├── .env.example           # Example environment variables
├── app-config.ts          # App branding/config
└── package.json
```

## Getting Started

1. **Install dependencies:**

```bash
pnpm install
```

2. **Copy and configure environment variables:**

```bash
cp .env.example .env.local
# Edit .env.local with your Google Cloud and LiveKit credentials
```

- For Google Vision/TTS, fill in the values from your Google Cloud service account JSON.
- For LiveKit, set your API key, secret, and server URL.

3. **Run the development server:**

```bash
pnpm dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

See `.env.example` for all required variables. Example:

```env
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
LIVEKIT_URL=wss://your-livekit-server

# Google Vision/TTS
VISION_OCR_TYPE=service_account
VISION_OCR_PROJECT_ID=your_project_id
VISION_OCR_PRIVATE_KEY_ID=your_private_key_id
VISION_OCR_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"
VISION_OCR_CLIENT_EMAIL=your_service_account_email@your_project_id.iam.gserviceaccount.com
VISION_OCR_CLIENT_ID=your_client_id
VISION_OCR_AUTH_URI=https://accounts.google.com/o/oauth2/auth
VISION_OCR_TOKEN_URI=https://oauth2.googleapis.com/token
VISION_OCR_AUTH_PROVIDER_X509_CERT_URL=https://www.googleapis.com/oauth2/v1/certs
VISION_OCR_CLIENT_X509_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/your_service_account_email%40your_project_id.iam.gserviceaccount.com
VISION_OCR_UNIVERSE_DOMAIN=googleapis.com
```

## Model Files

TFLite and ONNX models are stored in `public/models/` and loaded dynamically for inference. ONNX WASM runtimes are in `public/onnx-wasm/`.

## Customization

- Update `app-config.ts` to change branding, UI text, and feature toggles.
- Add or modify models in `public/models/` as needed.
- Extend API routes in `app/api/` for new ML or agent features.

## Configuration

This starter is designed to be flexible so you can adapt it to your specific agent use case. You can easily configure it to work with different types of inputs and outputs:

#### Example: App configuration (`app-config.ts`)

```ts
export const APP_CONFIG_DEFAULTS: AppConfig = {
  companyName: 'LiveKit',
  pageTitle: 'LiveKit Voice Agent',
  pageDescription: 'A voice agent built with LiveKit',

  supportsChatInput: true,
  supportsVideoInput: true,
  supportsScreenShare: true,
  isPreConnectBufferEnabled: true,

  logo: '/lk-logo.svg',
  accent: '#002cf2',
  logoDark: '/lk-logo-dark.svg',
  accentDark: '#1fd5f9',
  startButtonText: 'Start call',

  // for LiveKit Cloud Sandbox
  sandboxId: undefined,
  agentName: undefined,
};
```

You can update these values in [`app-config.ts`](./app-config.ts) to customize branding, features, and UI text for your deployment.

> [!NOTE]
> The `sandboxId` and `agentName` are for the LiveKit Cloud Sandbox environment.
> They are not used for local development.

#### Environment Variables

You'll also need to configure your LiveKit credentials in `.env.local` (copy `.env.example` if you don't have one):

```env
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
LIVEKIT_URL=https://your-livekit-server-url
```

These are required for the voice agent functionality to work with your LiveKit project.

## Contributing

This template is open source and we welcome contributions! Please open a PR or issue through GitHub, and don't forget to join us in the [LiveKit Community Slack](https://livekit.io/join-slack)!
