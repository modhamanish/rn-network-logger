/* eslint-disable no-console */
import { NativeModules } from 'react-native';

import { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

export interface GenericRequestLog {
  id?: string; // If not provided, a unique ID will be generated
  url: string;
  baseURL?: string;
  method: string;
  headers?: Record<string, any>;
  body?: any;
  timestamp?: number;
}

export interface GenericResponseLog {
  id: string; // Must match the request ID
  status: number;
  headers?: Record<string, any>;
  body?: any;
  duration?: number;
  isError?: boolean;
}

interface CustomRequestConfig extends InternalAxiosRequestConfig {
  metadata?: {
    requestId: string;
    startTime: number;
  };
}

let ws: WebSocket | null = null;
const logQueue: string[] = [];
let isConnected = false;

// Generate a simple unique ID for matching request & response
let requestCounter = 0;
function generateRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now()}_${requestCounter}`;
}

function getWebSocketUrl(): string {
  let host = 'localhost';
  if (__DEV__) {
    // Dynamically retrieve the Metro server IP to support simulators/emulators/physical devices
    const scriptURL = NativeModules.SourceCode?.scriptURL;
    if (scriptURL) {
      const match = scriptURL.match(/^https?:\/\/([^:/]+)(:\d+)?/);
      if (match) {
        host = match[1];
      }
    }
  }
  return `ws://${host}:19796`;
}

function connect() {
  if (ws) return;

  const url = getWebSocketUrl();
  console.log(`[NetworkInspector] Connecting to WebSocket: ${url}`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[NetworkInspector] Connected to VS Code Extension inspector.');
    isConnected = true;
    // Send queued logs
    while (logQueue.length > 0) {
      const log = logQueue.shift();
      if (log) ws?.send(log);
    }
  };

  ws.onclose = () => {
    isConnected = false;
    ws = null;
    // Automatically attempt reconnection every 3 seconds
    setTimeout(connect, 3000);
  };

  ws.onerror = e => {
    console.log('[NetworkInspector] Connection error:', e);
  };
}

function sendLog(payload: Record<string, unknown>) {
  if (!__DEV__) return;

  const message = JSON.stringify(payload);
  if (isConnected && ws && ws.readyState === 1) {
    ws.send(message);
  } else {
    logQueue.push(message);
    connect();
  }
}

export const networkLogger = {
  // Core Generic Logger Methods
  logGenericRequest(req: GenericRequestLog): string {
    if (!__DEV__) return '';

    const id = req.id || generateRequestId();
    let parsedBody = req.body;
    if (parsedBody && typeof parsedBody === 'string') {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch {
        // Fallback to raw string
      }
    }

    sendLog({
      id,
      type: 'request',
      timestamp: req.timestamp || Date.now(),
      url: req.url,
      baseURL: req.baseURL || '',
      method: (req.method || 'GET').toUpperCase(),
      headers: req.headers || {},
      body: parsedBody,
    });

    return id;
  },

  logGenericResponse(res: GenericResponseLog): void {
    if (!__DEV__) return;

    let parsedBody = res.body;
    if (parsedBody && typeof parsedBody === 'string') {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch {
        // Fallback to raw data
      }
    }

    sendLog({
      id: res.id,
      type: 'response',
      timestamp: Date.now(),
      duration: res.duration || 0,
      status: res.status,
      headers: res.headers || {},
      body: parsedBody,
      isError: res.isError || false,
    });
  },

  // Axios Specific Wrappers (Kept for compatibility, but not required if global is active)
  logRequest(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    if (!__DEV__) return config;

    // To prevent duplicate logs when global interception is active
    if ((config as any)._alreadyLogged) return config;
    (config as any)._alreadyLogged = true;

    const id = generateRequestId();
    const customConfig = config as CustomRequestConfig;
    customConfig.metadata = { requestId: id, startTime: Date.now() };

    // Set the header to tell XHR interceptor to skip logging
    if (config.headers) {
      config.headers['X-Logged-By-Axios'] = id;
    }

    this.logGenericRequest({
      id,
      url: config.url || '',
      baseURL: config.baseURL || '',
      method: config.method || 'GET',
      headers: config.headers as unknown as Record<string, any>,
      body: config.data,
      timestamp: Date.now(),
    });

    return config;
  },

  logResponse(response: AxiosResponse): AxiosResponse {
    if (!__DEV__) return response;

    const customConfig = response.config as CustomRequestConfig;
    const metadata = customConfig.metadata;

    // If it was already logged by XHR wrapper, skip
    if (!metadata || (response.config as any)._xhrLogged) return response;

    const id = metadata.requestId;
    const duration = Date.now() - metadata.startTime;

    this.logGenericResponse({
      id,
      status: response.status,
      headers: response.headers as unknown as Record<string, any>,
      body: response.data,
      duration,
      isError: false,
    });

    return response;
  },

  logError(error: any): void {
    if (!__DEV__) return;

    const config = error.config as CustomRequestConfig | undefined;

    // If it was already logged by XHR wrapper, skip
    if (!config || !config.metadata || (config as any)._xhrLogged) return;

    const metadata = config.metadata;
    const id = metadata.requestId;
    const duration = Date.now() - metadata.startTime;

    let responseData = error.response?.data;
    if (!responseData && error.message) {
      responseData = error.message;
    }

    this.logGenericResponse({
      id,
      status: error.response?.status || 0,
      headers: (error.response?.headers || {}) as Record<string, any>,
      body: responseData || 'Network Error',
      duration,
      isError: true,
    });
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readBlobAsText(blob: any): Promise<string> {
  return new Promise(resolve => {
    try {
      if (typeof blob.text === 'function') {
        blob
          .text()
          .then(resolve)
          .catch(() => resolve(''));
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const FileReaderClass = (global as any).FileReader;
        if (!FileReaderClass) {
          resolve('');
          return;
        }
        const reader = new FileReaderClass();
        reader.onloadend = () => {
          resolve(typeof reader.result === 'string' ? reader.result : '');
        };
        reader.onerror = () => resolve('');
        reader.readAsText(blob);
      }
    } catch {
      resolve('');
    }
  });
}

/// Global XMLHttpRequest interceptor
let isIntercepting = false;
export function startGlobalInterceptors() {
  if (isIntercepting) return;

  // @ts-ignore
  const OriginalXHR = global.XMLHttpRequest;
  if (!OriginalXHR) return;

  isIntercepting = true;
  console.log(
    '[NetworkInspector] Global XMLHttpRequest interceptor initialized.',
  );

  class InterceptedXHR extends OriginalXHR {
    _customRequestId: string;
    _customStartTime: number;
    _customMethod: string = 'GET';
    _customUrl: string = '';
    _customHeaders: Record<string, string> = {};
    _customXhrLoggedByAxios: boolean = false;
    _customResponseLogged: boolean = false;

    constructor() {
      super();

      this._customRequestId = generateRequestId();
      this._customStartTime = Date.now();

      // Register event listeners to log response when request completes
      const logResponse = async () => {
        if (
          this.readyState === 4 &&
          !this._customResponseLogged &&
          !this._customXhrLoggedByAxios
        ) {
          this._customResponseLogged = true;

          try {
            const duration = Date.now() - this._customStartTime;
            const responseHeaders: Record<string, string> = {};
            let headersString = '';
            try {
              // @ts-ignore
              headersString = this.getAllResponseHeaders() || '';
            } catch {
              // ignore
            }

            if (headersString) {
              headersString.split('\r\n').forEach((line: string) => {
                const parts = line.split(': ');
                if (parts.length >= 2) {
                  responseHeaders[parts[0]] = parts.slice(1).join(': ');
                }
              });
            }

            // @ts-ignore
            let responseBody = this.response;

            // If responseBody is a Blob, resolve its text content asynchronously
            if (
              responseBody &&
              typeof responseBody === 'object' &&
              responseBody.constructor &&
              responseBody.constructor.name === 'Blob'
            ) {
              try {
                responseBody = await readBlobAsText(responseBody);
              } catch {
                responseBody = 'Error reading Blob response';
              }
            }

            if (typeof responseBody === 'string') {
              try {
                responseBody = JSON.parse(responseBody);
              } catch {
                // Fallback to raw response data
              }
            }

            // @ts-ignore
            const status = this.status;
            const isError = status === 0 || status >= 400;

            networkLogger.logGenericResponse({
              id: this._customRequestId,
              status: status || 0,
              headers: responseHeaders,
              body: responseBody || (isError ? 'Network Error' : null),
              duration,
              isError,
            });
          } catch (err) {
            console.error('[NetworkInspector] Error parsing response:', err);
          }
        }
      };

      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4) {
          logResponse();
        }
      });
      this.addEventListener('load', logResponse);
      this.addEventListener('error', logResponse);
      this.addEventListener('timeout', logResponse);
      this.addEventListener('abort', logResponse);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    open(method: string, url: string, ...args: any[]) {
      this._customMethod = method;
      this._customUrl = url;
      this._customHeaders = {};
      // @ts-ignore
      return super.open(method, url, ...args);
    }

    setRequestHeader(header: string, value: string) {
      if (!this._customHeaders) {
        this._customHeaders = {};
      }
      this._customHeaders[header] = value;
      // @ts-ignore
      return super.setRequestHeader(header, value);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(body: any) {
      // Tag this request to prevent double logging in Axios wrappers
      // @ts-ignore
      this._xhrLogged = true;

      const isLoggedByAxios =
        this._customHeaders &&
        (this._customHeaders['X-Logged-By-Axios'] ||
          this._customHeaders['x-logged-by-axios']);
      if (isLoggedByAxios) {
        this._customXhrLoggedByAxios = true;
      }

      let parsedBody = body;
      if (typeof body === 'string') {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          // Fallback to raw data
        }
      }

      if (!this._customXhrLoggedByAxios) {
        networkLogger.logGenericRequest({
          id: this._customRequestId,
          url: this._customUrl,
          method: this._customMethod,
          headers: this._customHeaders,
          body: parsedBody,
          timestamp: this._customStartTime,
        });
      }

      // @ts-ignore
      return super.send(body);
    }
  }

  // @ts-ignore
  global.XMLHttpRequest = InterceptedXHR;
}

// Auto-connect and start global interception in development mode on import
if (__DEV__) {
  connect();
  try {
    startGlobalInterceptors();
  } catch (e) {
    console.error(
      '[NetworkInspector] Failed to initialize global interceptor:',
      e,
    );
  }
}

export default networkLogger;

