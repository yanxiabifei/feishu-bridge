class FeishuError extends Error {
  constructor(code, msg, path) {
    super(`Feishu ${code}: ${msg} (${path})`);
    this.name = 'FeishuError';
    this.code = code;
    this.path = path;
  }
}

const CHAT_NOT_FOUND = 230002;

// 飞书认定 tenant_access_token 无效的两个码：清缓存重取一次即可恢复
// （99991661 是请求头没带，99991671 是格式不对，重试没有意义）
const TOKEN_INVALID = new Set([99991663, 99991664]);

// 附件按体积算：几十 MB 的文件在慢网下十几秒传不完，跟着业务接口的 15 秒超时走会误报下载失败
const DOWNLOAD_TIMEOUT_MS = 120000;

function createApi({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://open.feishu.cn',
  now = () => Date.now(),
  requestTimeoutMs = 15000,
}) {
  let token = null;
  let tokenExp = 0;
  let inflight = null;

  // 飞书接口偶发不响应时，裸 fetch 会挂到 TCP 超时（几分钟），期间所有消息都堵着。
  // 统一加超时，并换成中文错误，免得日志里只看到 AbortError。
  async function callFetch(url, opts, timeoutMs = requestTimeoutMs) {
    try {
      return await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw toTimeoutError(err, url, timeoutMs);
    }
  }

  // 超时信号也可能在响应头之后、读响应体时才触发，此时抛的是裸 TimeoutError：
  // 和请求阶段一样换成中文错误，否则日志里看不出是超时。
  function toTimeoutError(err, url, timeoutMs) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return new Error(`飞书请求超时（${Math.round(timeoutMs / 1000)} 秒）：${new URL(url).pathname}`);
    }
    return err;
  }

  async function readBody(url, promise, timeoutMs = requestTimeoutMs) {
    try {
      return await promise;
    } catch (err) {
      throw toTimeoutError(err, url, timeoutMs);
    }
  }

  function getToken() {
    if (token && now() < tokenExp - 60000) return Promise.resolve(token);
    if (inflight) return inflight;
    inflight = (async () => {
      const url = `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
      const res = await callFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const json = await readBody(url, res.json());
      if (json.code !== 0) {
        throw new FeishuError(json.code, json.msg, '/open-apis/auth/v3/tenant_access_token/internal');
      }
      token = json.tenant_access_token;
      tokenExp = now() + json.expire * 1000;
      return token;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function requestOnce(method, path, { query, body, raw = false, timeoutMs } = {}) {
    const t = await getToken();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const url = `${baseUrl}${path}${qs}`;
    const res = await callFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    // 网关 5xx 返回的是 HTML，直接 res.json() 会变成 "Unexpected token '<'"
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new FeishuError(res.status, `HTTP ${res.status}${snippet ? ` ${snippet}` : ''}`, path);
    }
    const bodyTimeoutMs = timeoutMs || requestTimeoutMs;
    if (raw) return Buffer.from(await readBody(url, res.arrayBuffer(), bodyTimeoutMs));
    const json = await readBody(url, res.json(), bodyTimeoutMs);
    if (json.code !== 0) throw new FeishuError(json.code, json.msg, path);
    return json.data;
  }

  // token 被服务端判无效（密钥轮换、提前吊销）时缓存还活着，所有请求会一直失败到过期。
  // 清掉缓存、重取一次；业务请求本身在鉴权前就被拒了，重试不会重复执行。
  async function withTokenRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof FeishuError) || !TOKEN_INVALID.has(err.code)) throw err;
      token = null;
      tokenExp = 0;
      // 不碰 inflight：同时失效的多条请求如果各自清空它，会各自再发一次取 token，
      // 并发一上去就是一串重复请求（飞书这个接口有频率限制）。正在飞的那次拿到的
      // 本来就是新 token，等它就行。inflight 置空由 getToken 自己收尾。
      return fn();
    }
  }

  const request = (method, path, opts) => withTokenRetry(() => requestOnce(method, path, opts));

  const sendMessage = async (chatId, msgType, content) => {
    const data = await request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
    return data.message_id;
  };

  return {
    getToken,

    sendMessage,

    sendText: (chatId, text) => sendMessage(chatId, 'text', { text }),

    sendCard: (chatId, card) => sendMessage(chatId, 'interactive', card),

    createCardEntity: async (card) => {
      const data = await request('POST', '/open-apis/cardkit/v1/cards', {
        body: { type: 'card_json', data: JSON.stringify(card) },
      });
      return data.card_id;
    },

    updateCardEntity: (cardId, card, sequence) => request('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, {
      body: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence,
        uuid: `${cardId}-${sequence}`,
      },
    }),

    sendCardEntity: (chatId, cardId) => sendMessage(chatId, 'interactive', {
      type: 'card', data: { card_id: cardId },
    }),

    createGroup: async (name, openIds) => {
      const data = await request('POST', '/open-apis/im/v1/chats', {
        query: { user_id_type: 'open_id' },
        body: { name, chat_mode: 'group', chat_type: 'private', user_id_list: openIds },
      });
      return data.chat_id;
    },

    getChat: async (chatId) => {
      try {
        return await request('GET', `/open-apis/im/v1/chats/${chatId}`);
      } catch (err) {
        if (err instanceof FeishuError && err.code === CHAT_NOT_FOUND) return null;
        throw err;
      }
    },

    renameChat: (chatId, name) => request('PUT', `/open-apis/im/v1/chats/${chatId}`, {
      body: { name },
    }),

    disbandChat: (chatId) => request('DELETE', `/open-apis/im/v1/chats/${chatId}`),

    downloadResource: (messageId, fileKey, type) => request(
      'GET',
      `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      { query: { type }, raw: true, timeoutMs: DOWNLOAD_TIMEOUT_MS },
    ),

    getBotInfo: () => withTokenRetry(async () => {
      // bot/v3/info 把结果放在顶层 bot 字段，没有 data 包装，不能复用 request
      const url = `${baseUrl}/open-apis/bot/v3/info`;
      const t = await getToken();
      const res = await callFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${t}` },
      });
      if (!res.ok) throw new FeishuError(res.status, `HTTP ${res.status}`, '/open-apis/bot/v3/info');
      const json = await readBody(url, res.json());
      if (json.code !== 0) throw new FeishuError(json.code, json.msg, '/open-apis/bot/v3/info');
      return json.bot;
    }),
  };
}

module.exports = { createApi, FeishuError };
