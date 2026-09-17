/* eslint-disable no-console */
import { NativeModules, Platform } from 'react-native';

export interface InternalAxiosRequestConfig<T = any> {
  url?: string;
  method?: string;
  baseURL?: string;
  headers?: any;
  params?: any;
  data?: any;
  [key: string]: any;
}

export interface AxiosResponse<T = any, D = any> {
  data: T;
  status: number;
  statusText?: string;
  headers: any;
  config: InternalAxiosRequestConfig<D>;
  request?: any;
}

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

  // On Android, if the host resolves to loopback (localhost or 127.0.0.1),
  // fallback to 10.0.2.2 (host loopback) if running on an emulator.
  if (Platform.OS === 'android' && (host === 'localhost' || host === '127.0.0.1')) {
    const isEmulator =
      (Platform.constants as any).Fingerprint?.startsWith('generic') ||
      (Platform.constants as any).Fingerprint?.startsWith('unknown') ||
      (Platform.constants as any).Model?.includes('google_sdk') ||
      (Platform.constants as any).Model?.includes('Emulator') ||
      (Platform.constants as any).Model?.includes('Android SDK built for x86') ||
      (Platform.constants as any).Brand?.startsWith('generic') ||
      (Platform.constants as any).Device?.startsWith('generic');

    if (isEmulator) {
      host = '10.0.2.2';
    }
  }

  return `ws://${host}:19796`;
}

let connectionAttempted = false;
let wasConnectedBefore = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function connect() {
  if (ws || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

  const url = getWebSocketUrl();
  if (!connectionAttempted) {
    console.log(`[NetworkInspector] Initializing connection to: ${url}`);
    connectionAttempted = true;
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[NetworkInspector] Connected to Network Inspector Server.');
    isConnected = true;
    wasConnectedBefore = true;
    reconnectAttempts = 0; // Reset counter on successful connection

    // Register device info with the server
    let model = 'Unknown Device';
    try {
      if (Platform.OS === 'android') {
        model = (Platform.constants as any)?.Model || 'Android Device';
      } else if (Platform.OS === 'ios') {
        model = Platform.isPad ? 'iPad' : 'iPhone';
      } else {
        model = Platform.OS || 'Unknown Device';
      }
    } catch (e) {
      // ignore
    }

    try {
      ws?.send(
        JSON.stringify({
          type: 'register',
          deviceInfo: {
            platform: Platform.OS,
            version: Platform.Version,
            model: model,
          },
        })
      );
    } catch (e) {
      // ignore
    }

    // Send queued logs
    while (logQueue.length > 0) {
      const log = logQueue.shift();
      if (log) ws?.send(log);
    }
  };

  ws.onclose = () => {
    isConnected = false;
    ws = null;

    if (wasConnectedBefore) {
      console.log('[NetworkInspector] Connection lost. Reconnecting in background...');
      wasConnectedBefore = false;
      reconnectAttempts = 0; // Reset counter since it was a live connection drop
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts += 1;
      // Automatically attempt reconnection every 3 seconds
      setTimeout(connect, 3000);
    } else {
      console.log(`[NetworkInspector] Reconnection disabled after ${MAX_RECONNECT_ATTEMPTS} failed attempts. Please reload the app (press 'r') once the inspector server is running.`);
    }
  };

  ws.onerror = () => {
    // Silent onerror to prevent infinite logs loop in Metro console
  };
}

function sendLog(payload: Record<string, unknown>) {
  if (!__DEV__) return;

  try {
    const message = JSON.stringify(payload);
    if (isConnected && ws && ws.readyState === 1) {
      ws.send(message);
    } else {
      logQueue.push(message);
      connect();
    }
  } catch (e) {
    try {
      const safePayload = { ...payload, body: '[Unserializable body]' };
      const safeMessage = JSON.stringify(safePayload);
      if (isConnected && ws && ws.readyState === 1) {
        ws.send(safeMessage);
      } else {
        logQueue.push(safeMessage);
      }
    } catch {
      // ignore
    }
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
let isExecutingFetch = false;

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
    _customXhrLoggedByFetch: boolean = false;
    _customResponseLogged: boolean = false;

    constructor() {
      super();

      this._customRequestId = generateRequestId();
      this._customStartTime = Date.now();
      if (isExecutingFetch) {
        this._customXhrLoggedByFetch = true;
      }

      // Register event listeners to log response when request completes
      const logResponse = async () => {
        if (
          this.readyState === 4 &&
          !this._customResponseLogged &&
          !this._customXhrLoggedByAxios &&
          !this._customXhrLoggedByFetch
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
      if (isExecutingFetch) {
        this._customXhrLoggedByFetch = true;
      }
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

      if (isExecutingFetch) {
        this._customXhrLoggedByFetch = true;
      }

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

      if (!this._customXhrLoggedByAxios && !this._customXhrLoggedByFetch) {
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

let isFetchIntercepting = false;
export function startGlobalFetchInterceptor() {
  if (isFetchIntercepting) return;

  const originalFetch = (globalThis as any).fetch || (global as any).fetch;
  if (!originalFetch) return;

  isFetchIntercepting = true;
  console.log('[NetworkInspector] Global fetch interceptor initialized.');

  const interceptedFetch = async function (
    input: any,
    init?: any
  ): Promise<any> {
    let url = '';
    let method = 'GET';
    let headers: Record<string, string> = {};
    let body: any = undefined;

    // 1. Safe URL & Method extraction (supports string, URL object, Request object)
    try {
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object') {
        if (typeof input.url === 'string') {
          url = input.url;
        } else if (typeof input.href === 'string') {
          url = input.href;
        } else if (typeof input.toString === 'function') {
          const str = input.toString();
          if (str !== '[object Object]') {
            url = str;
          }
        }
        if (input.method) {
          method = input.method;
        }
      }
    } catch {
      // Fallback
    }

    // 2. Ignore Metro bundler, HMR, and Inspector server traffic only
    const isInternalTraffic =
      !url ||
      url.includes(':19796') || // Inspector WebSocket / server port
      url.includes(':8081') ||  // Standard Metro port
      url.includes(':8082') ||  // Alternate Metro port
      url.includes('/symbolicate') || // Metro error symbolicator
      url.includes('/open-debugger') ||
      url.includes('/inspector/device');

    if (isInternalTraffic) {
      return originalFetch(input, init);
    }

    // 3. Extract method and headers safely
    try {
      if (init?.method) method = init.method;

      const rawHeaders =
        init?.headers ||
        (input && typeof input === 'object' ? input.headers : undefined);
      if (rawHeaders) {
        if (typeof rawHeaders.forEach === 'function') {
          rawHeaders.forEach((value: string, key: string) => {
            headers[key] = value;
          });
        } else if (Array.isArray(rawHeaders)) {
          rawHeaders.forEach(([key, value]: [string, string]) => {
            headers[key] = value;
          });
        } else if (typeof rawHeaders === 'object') {
          Object.keys(rawHeaders).forEach(k => {
            headers[k] = String(rawHeaders[k]);
          });
        }
      }

      if (init?.body !== undefined) {
        body = init.body;
      }
    } catch {
      // Ignore header/body extraction issues
    }

    // 4. Format body safely (including FormData & Hermes minified classes)
    let parsedBody: any = body;
    try {
      const isFormData =
        (typeof (global as any).FormData !== 'undefined' &&
          body instanceof (global as any).FormData) ||
        (body &&
          typeof body === 'object' &&
          (body.constructor?.name === 'FormData' ||
            Array.isArray((body as any)._parts)));

      if (isFormData) {
        if (body && Array.isArray((body as any)._parts)) {
          const partsSummary = (body as any)._parts.map(
            ([key, val]: [string, any]) => {
              if (val && typeof val === 'object' && val.uri) {
                return `${key}: [File: ${val.name || val.uri}]`;
              }
              return `${key}: ${typeof val === 'object' ? '[Object]' : val}`;
            },
          );
          parsedBody = `[FormData: ${partsSummary.join(', ')}]`;
        } else {
          parsedBody = '[FormData]';
        }
      } else if (typeof body === 'string') {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      }
    } catch {
      parsedBody = '[Unparsable Body]';
    }

    const id = generateRequestId();
    const startTime = Date.now();

    try {
      networkLogger.logGenericRequest({
        id,
        url,
        method: (method || 'GET').toUpperCase(),
        headers,
        body: parsedBody,
        timestamp: startTime,
      });
    } catch {
      // Don't let logging errors break application code
    }

    // 5. Execute original fetch
    let response: any;
    try {
      isExecutingFetch = true;
      response = await originalFetch(input, init);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      try {
        networkLogger.logGenericResponse({
          id,
          status: 0,
          headers: {},
          body: err?.message || 'Network Error',
          duration,
          isError: true,
        });
      } catch {
        // ignore
      }
      // Re-throw directly without retrying
      throw err;
    } finally {
      isExecutingFetch = false;
    }

    // 6. Process response asynchronously in background (ZERO blocking lag for caller!)
    const duration = Date.now() - startTime;
    const status = response?.status || 0;
    const isError = status === 0 || status >= 400;

    // Clone response immediately while body stream is fresh
    let clonedResponse: any = null;
    try {
      if (typeof response.clone === 'function') {
        clonedResponse = response.clone();
      }
    } catch {
      // Stream may be already consumed or not cloneable
    }

    (async () => {
      try {
        const responseHeaders: Record<string, string> = {};
        if (response.headers && typeof response.headers.forEach === 'function') {
          response.headers.forEach((val: string, key: string) => {
            responseHeaders[key] = val;
          });
        } else if (response.headers && typeof response.headers === 'object') {
          Object.keys(response.headers).forEach(k => {
            responseHeaders[k] = String(response.headers[k]);
          });
        }

        const contentType = (
          (typeof response.headers?.get === 'function'
            ? response.headers.get('content-type')
            : '') ||
          responseHeaders['content-type'] ||
          responseHeaders['Content-Type'] ||
          ''
        ).toLowerCase();

        const isBinary =
          contentType.includes('image/') ||
          contentType.includes('audio/') ||
          contentType.includes('video/') ||
          contentType.includes('application/octet-stream') ||
          contentType.includes('application/pdf') ||
          contentType.includes('application/zip');

        let responseBody: any = null;

        if (isBinary) {
          responseBody = `[Binary: ${contentType || 'blob'}]`;
        } else if (status === 204 || status === 304) {
          responseBody = null;
        } else if (clonedResponse) {
          try {
            const text = await clonedResponse.text();
            if (text) {
              if (text.length > 500000) {
                responseBody = text.slice(0, 500000) + '... [Truncated]';
              } else {
                try {
                  responseBody = JSON.parse(text);
                } catch {
                  responseBody = text;
                }
              }
            }
          } catch {
            responseBody = '[Response stream already consumed or binary]';
          }
        }

        networkLogger.logGenericResponse({
          id,
          status,
          headers: responseHeaders,
          body:
            responseBody !== null && responseBody !== undefined
              ? responseBody
              : isError
                ? 'Network Error'
                : null,
          duration,
          isError,
        });
      } catch {
        // Prevent background logging errors from affecting runtime
      }
    })();

    return response;
  };

  (global as any).fetch = interceptedFetch;
  (globalThis as any).fetch = interceptedFetch;
  if (typeof window !== 'undefined' && (window as any).fetch) {
    (window as any).fetch = interceptedFetch;
  }
}

// Auto-connect and start global interception in development mode on import
if (__DEV__) {
  connect();
  try {
    startGlobalInterceptors();
    startGlobalFetchInterceptor();
  } catch (e) {
    console.error(
      '[NetworkInspector] Failed to initialize global interceptor:',
      e,
    );
  }
}

export default networkLogger;

