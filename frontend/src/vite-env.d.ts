/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the backend API (e.g. http://localhost:8080). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
