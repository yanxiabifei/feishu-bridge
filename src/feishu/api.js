class FeishuError extends Error {
  constructor(code, msg, path) {
    super(`Feishu ${code}: ${msg} (${path})`);
    this.name = 'FeishuError';
    this.code = code;
    this.path = path;
  }
}

const CHAT_NOT_FOUND = 230002;

function createApi({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://open.feishu.cn',
  now = () => Date.now(),
}) {
  let token = null;
  let tokenExp = 0;
  let inflight = null;

  function getToken(force = false) {
    if (!force && token && now() < tokenExp - 60000) return Promise.resolve(token);
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const json = await res.json();
      if (json.code !== 0) {
        throw new FeishuError(json.code, json.msg, '/open-apis/auth/v3/tenant_access_token/internal');
      }
      token = json.tenant_access_token;
      tokenExp = now() + json.expire * 1000;
      return token;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function request(method, path, { query, body, raw = false } = {}) {
    const t = await getToken();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetchImpl(`${baseUrl}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) {
      if (!res.ok) throw new FeishuError(res.status, await res.text(), path);
      return Buffer.from(await res.arrayBuffer());
    }
    const json = await res.json();
    if (json.code !== 0) throw new FeishuError(json.code, json.msg, path);
    return json.data;
  }

  const sendMessage = async (chatId, msgType, content) => {
    const data = await request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
    return data.message_id;
  };

  return {
    token: getToken,

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

    disbandChat: (chatId) => request('DELETE', `/open-apis/im/v1/chats/${chatId}`),

    downloadResource: (messageId, fileKey, type) => request(
      'GET',
      `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      { query: { type }, raw: true },
    ),

    getBotInfo: async () => {
      // bot/v3/info 把结果放在顶层 bot 字段，没有 data 包装，不能复用 request
      const t = await getToken();
      const res = await fetchImpl(`${baseUrl}/open-apis/bot/v3/info`, {
        method: 'GET',
        headers: { authorization: `Bearer ${t}` },
      });
      const json = await res.json();
      if (json.code !== 0) throw new FeishuError(json.code, json.msg, '/open-apis/bot/v3/info');
      return json.bot;
    },
  };
}

module.exports = { createApi, FeishuError };
